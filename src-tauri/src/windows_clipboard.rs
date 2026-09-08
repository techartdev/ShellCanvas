// SPDX-License-Identifier: MPL-2.0
//! Windows virtual-file clipboard. No local file staging or protocol-specific paths.
#![allow(non_snake_case)]
use crate::clipboard_stream::{RemoteStream, Sources};
use std::{
    ffi::c_void,
    mem::{size_of, ManuallyDrop},
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex, OnceLock,
    },
    time::Duration,
};
use windows::{
    core::{implement, w, Error, Ref, Result, BOOL, HRESULT},
    Win32::{
        Foundation::*,
        System::{Com::*, DataExchange::RegisterClipboardFormatW, Memory::*, Ole::*},
        UI::{Shell::*, WindowsAndMessaging::*},
    },
};

fn failure(message: impl std::fmt::Display) -> Error {
    Error::new(E_FAIL, message.to_string())
}
fn format(id: u16, medium: TYMED, index: i32) -> FORMATETC {
    FORMATETC {
        cfFormat: id,
        dwAspect: DVASPECT_CONTENT.0,
        lindex: index,
        tymed: medium.0 as u32,
        ..Default::default()
    }
}
fn global(bytes: &[u8]) -> Result<STGMEDIUM> {
    // Ownership transfers to ReleaseStgMedium after a successful return.
    unsafe {
        let allocation = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len())?;
        let destination = GlobalLock(allocation);
        if destination.is_null() {
            let _ = GlobalFree(Some(allocation));
            return Err(Error::from_win32());
        }
        ptr::copy_nonoverlapping(bytes.as_ptr(), destination.cast(), bytes.len());
        let _ = GlobalUnlock(allocation);
        Ok(STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 {
                hGlobal: allocation,
            },
            ..Default::default()
        })
    }
}

fn global_fill(length: usize, fill: impl FnOnce(*mut u8) -> Result<()>) -> Result<STGMEDIUM> {
    unsafe {
        let allocation = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, length)?;
        let bytes = GlobalLock(allocation).cast::<u8>();
        if bytes.is_null() {
            let _ = GlobalFree(Some(allocation));
            return Err(Error::from_win32());
        }
        let result = fill(bytes);
        let _ = GlobalUnlock(allocation);
        if let Err(error) = result {
            let _ = GlobalFree(Some(allocation));
            return Err(error);
        }
        Ok(STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 {
                hGlobal: allocation,
            },
            ..Default::default()
        })
    }
}

#[implement(IDataObject, IDataObjectAsyncCapability)]
struct VirtualFiles {
    sources: Sources,
    descriptors: u16,
    contents: u16,
    effect: u16,
    marker: u16,
    asynchronous: AtomicBool,
    operation: AtomicBool,
}
impl VirtualFiles {
    fn new(sources: impl Into<Sources>) -> Self {
        let sources = sources.into();
        unsafe {
            Self {
                sources,
                descriptors: RegisterClipboardFormatW(w!("FileGroupDescriptorW")) as u16,
                contents: RegisterClipboardFormatW(w!("FileContents")) as u16,
                effect: RegisterClipboardFormatW(w!("Preferred DropEffect")) as u16,
                marker: RegisterClipboardFormatW(w!("ShellCanvas.RemoteSelection")) as u16,
                asynchronous: AtomicBool::new(true),
                operation: AtomicBool::new(false),
            }
        }
    }
    fn query(&self, value: &FORMATETC) -> HRESULT {
        if value.dwAspect != DVASPECT_CONTENT.0 || !value.ptd.is_null() {
            return DV_E_DVASPECT;
        }
        if (value.cfFormat == self.marker
            || (!self.sources.is_empty()
                && (value.cfFormat == self.descriptors || value.cfFormat == self.effect)))
            && value.tymed & TYMED_HGLOBAL.0 as u32 != 0
            && value.lindex == -1
        {
            return S_OK;
        }
        if value.cfFormat == self.contents
            && value.tymed & TYMED_ISTREAM.0 as u32 != 0
            && value.lindex >= 0
            && (value.lindex as usize) < self.sources.len()
            && self
                .sources
                .get(value.lindex as usize)
                .is_ok_and(|source| source.entry.kind == "file")
        {
            return S_OK;
        }
        DV_E_FORMATETC
    }
}
impl IDataObject_Impl for VirtualFiles_Impl {
    fn GetData(&self, request: *const FORMATETC) -> Result<STGMEDIUM> {
        let request = unsafe { request.as_ref() }.ok_or_else(|| Error::from(E_POINTER))?;
        self.query(request).ok()?;
        if request.cfFormat == self.marker {
            return global(b"ShellCanvas remote selection\0");
        }
        if request.cfFormat == self.effect {
            return global(&1u32.to_le_bytes());
        }
        if request.cfFormat == self.descriptors {
            let length = self
                .sources
                .len()
                .checked_mul(size_of::<FILEDESCRIPTORW>())
                .and_then(|size| size.checked_add(4))
                .ok_or_else(|| failure("Clipboard descriptor size overflow"))?;
            // Windows requires one contiguous HGLOBAL. Fill it directly from
            // the disk catalog, avoiding a second full-sized Rust byte vector.
            return global_fill(length, |bytes| {
                unsafe {
                    ptr::write_unaligned(bytes.cast::<u32>(), self.sources.len() as u32);
                }
                for index in 0..self.sources.len() {
                    let source = self.sources.get(index).map_err(failure)?;
                    let mut descriptor = FILEDESCRIPTORW {
                        dwFlags: (FD_FILESIZE.0 | FD_ATTRIBUTES.0 | FD_PROGRESSUI.0 | FD_UNICODE.0)
                            as u32,
                        dwFileAttributes: if source.entry.kind == "directory" {
                            0x10
                        } else {
                            0x80
                        },
                        nFileSizeHigh: (source.entry.size >> 32) as u32,
                        nFileSizeLow: source.entry.size as u32,
                        ..Default::default()
                    };
                    if source.entry.kind == "directory" {
                        descriptor.dwFlags &= !(FD_FILESIZE.0 as u32);
                    }
                    let name: Vec<_> = source.display_path.encode_utf16().collect();
                    let mut filename = [0u16; 260];
                    if name.len() >= filename.len() {
                        return Err(failure("Filename is too long for Explorer"));
                    }
                    filename[..name.len()].copy_from_slice(&name);
                    descriptor.cFileName = filename;

                    unsafe {
                        ptr::write_unaligned(
                            bytes
                                .add(4 + index * size_of::<FILEDESCRIPTORW>())
                                .cast::<FILEDESCRIPTORW>(),
                            descriptor,
                        );
                    }
                }
                Ok(())
            });
        }
        let mut stream =
            RemoteStream::new(self.sources.get(request.lindex as usize).map_err(failure)?);
        // Explorer may never Read an empty file; validate it at Paste/GetData.
        if stream.source.entry.size == 0 {
            stream.read(&mut [0u8; 1]).map_err(failure)?;
        }
        let stream: IStream = FileStream {
            inner: Mutex::new(stream),
        }
        .into();
        Ok(STGMEDIUM {
            tymed: TYMED_ISTREAM.0 as u32,
            u: STGMEDIUM_0 {
                pstm: ManuallyDrop::new(Some(stream)),
            },
            ..Default::default()
        })
    }
    fn GetDataHere(&self, _: *const FORMATETC, _: *mut STGMEDIUM) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn QueryGetData(&self, request: *const FORMATETC) -> HRESULT {
        unsafe { request.as_ref() }.map_or(E_POINTER, |request| self.query(request))
    }
    fn GetCanonicalFormatEtc(&self, _: *const FORMATETC, output: *mut FORMATETC) -> HRESULT {
        if let Some(output) = unsafe { output.as_mut() } {
            output.ptd = ptr::null_mut();
        }
        DATA_S_SAMEFORMATETC
    }
    fn SetData(&self, _: *const FORMATETC, medium: *const STGMEDIUM, release: BOOL) -> Result<()> {
        // Accept Shell completion metadata, never implement delete-on-paste.
        if release.as_bool() && !medium.is_null() {
            unsafe {
                let mut owned = ptr::read(medium);
                ReleaseStgMedium(&mut owned);
            }
        }
        Ok(())
    }
    fn EnumFormatEtc(&self, direction: u32) -> Result<IEnumFORMATETC> {
        if direction != DATADIR_GET.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        unsafe {
            if self.sources.is_empty() {
                return SHCreateStdEnumFmtEtc(&[format(self.marker, TYMED_HGLOBAL, -1)]);
            }
            SHCreateStdEnumFmtEtc(&[
                format(self.descriptors, TYMED_HGLOBAL, -1),
                format(self.contents, TYMED_ISTREAM, -1),
                format(self.effect, TYMED_HGLOBAL, -1),
            ])
        }
    }
    fn DAdvise(&self, _: *const FORMATETC, _: u32, _: Ref<'_, IAdviseSink>) -> Result<u32> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
    fn DUnadvise(&self, _: u32) -> Result<()> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
    fn EnumDAdvise(&self) -> Result<IEnumSTATDATA> {
        Err(OLE_E_ADVISENOTSUPPORTED.into())
    }
}
impl IDataObjectAsyncCapability_Impl for VirtualFiles_Impl {
    fn SetAsyncMode(&self, value: BOOL) -> Result<()> {
        self.asynchronous.store(value.as_bool(), Ordering::Relaxed);
        Ok(())
    }
    fn GetAsyncMode(&self) -> Result<BOOL> {
        Ok(self.asynchronous.load(Ordering::Relaxed).into())
    }
    fn StartOperation(&self, _: Ref<'_, IBindCtx>) -> Result<()> {
        self.operation.store(true, Ordering::Relaxed);
        Ok(())
    }
    fn InOperation(&self) -> Result<BOOL> {
        Ok(self.operation.load(Ordering::Relaxed).into())
    }
    fn EndOperation(&self, _: HRESULT, _: Ref<'_, IBindCtx>, _: u32) -> Result<()> {
        self.operation.store(false, Ordering::Relaxed);
        Ok(())
    }
}

#[implement(IStream)]
struct FileStream {
    inner: Mutex<RemoteStream>,
}
impl ISequentialStream_Impl for FileStream_Impl {
    fn Read(&self, output: *mut c_void, count: u32, read: *mut u32) -> HRESULT {
        if !read.is_null() {
            unsafe {
                *read = 0;
            }
        }
        if count == 0 {
            return S_OK;
        }
        if output.is_null() {
            return E_POINTER;
        }
        let result = self.inner.lock().map_err(failure).and_then(|mut stream| {
            // COM owns and validates the caller's buffer lifetime for this call.
            stream
                .read(unsafe {
                    std::slice::from_raw_parts_mut(output.cast::<u8>(), count as usize)
                })
                .map_err(failure)
        });
        match result {
            Ok(length) => {
                if !read.is_null() {
                    unsafe {
                        *read = length as u32;
                    }
                }
                if length == count as usize {
                    S_OK
                } else {
                    S_FALSE
                }
            }
            Err(error) => error.code(),
        }
    }
    fn Write(&self, _: *const c_void, _: u32, written: *mut u32) -> HRESULT {
        if !written.is_null() {
            unsafe {
                *written = 0;
            }
        }
        STG_E_ACCESSDENIED
    }
}
impl IStream_Impl for FileStream_Impl {
    fn Seek(&self, offset: i64, origin: STREAM_SEEK, output: *mut u64) -> Result<()> {
        let position = self
            .inner
            .lock()
            .map_err(failure)?
            .seek(offset, origin.0)
            .map_err(failure)?;
        if !output.is_null() {
            unsafe {
                *output = position;
            }
        }
        Ok(())
    }
    fn SetSize(&self, _: u64) -> Result<()> {
        Err(STG_E_ACCESSDENIED.into())
    }
    fn CopyTo(
        &self,
        destination: Ref<'_, IStream>,
        count: u64,
        read: *mut u64,
        written: *mut u64,
    ) -> Result<()> {
        let destination = destination.as_ref().ok_or_else(|| Error::from(E_POINTER))?;
        if !read.is_null() {
            unsafe {
                *read = 0;
            }
        }
        if !written.is_null() {
            unsafe {
                *written = 0;
            }
        }
        let mut total = 0u64;
        let mut bytes = [0u8; 32768];
        while total < count {
            let mut got = 0;
            let result = self.Read(
                bytes.as_mut_ptr().cast(),
                (count - total).min(bytes.len() as u64) as u32,
                &mut got,
            );
            result.ok()?;
            if got == 0 {
                break;
            }
            let mut sent = 0;
            unsafe {
                destination
                    .Write(bytes.as_ptr().cast(), got, Some(&mut sent))
                    .ok()?;
            }
            if sent != got {
                return Err(STG_E_MEDIUMFULL.into());
            }
            total += got as u64;
            if !read.is_null() {
                unsafe {
                    *read = total;
                }
            }
            if !written.is_null() {
                unsafe {
                    *written = total;
                }
            }
        }
        Ok(())
    }
    fn Commit(&self, _: &STGC) -> Result<()> {
        Ok(())
    }
    fn Revert(&self) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn LockRegion(&self, _: u64, _: u64, _: &LOCKTYPE) -> Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }
    fn UnlockRegion(&self, _: u64, _: u64, _: u32) -> Result<()> {
        Err(STG_E_INVALIDFUNCTION.into())
    }
    fn Stat(&self, output: *mut STATSTG, _: &STATFLAG) -> Result<()> {
        let output = unsafe { output.as_mut() }.ok_or_else(|| Error::from(E_POINTER))?;
        *output = STATSTG {
            r#type: STGTY_STREAM.0 as u32,
            cbSize: self.inner.lock().map_err(failure)?.source.entry.size,
            grfMode: STGM_READ,
            ..Default::default()
        };
        Ok(())
    }
    fn Clone(&self) -> Result<IStream> {
        let old = self.inner.lock().map_err(failure)?;
        let mut stream = RemoteStream::new(old.source.clone());
        stream.position = old.position;
        Ok(FileStream {
            inner: Mutex::new(stream),
        }
        .into())
    }
}

struct Offer {
    sources: Sources,
    sequence: u32,
    reply: tokio::sync::oneshot::Sender<std::result::Result<u32, String>>,
}
enum Request {
    Publish(Offer),
    Sequence(tokio::sync::oneshot::Sender<u32>),
}
static OFFERS: OnceLock<std::result::Result<mpsc::SyncSender<Request>, String>> = OnceLock::new();
#[cfg(test)]
#[path = "windows_clipboard_tests.rs"]
mod tests;
fn sender() -> std::result::Result<&'static mpsc::SyncSender<Request>, String> {
    OFFERS.get_or_init(|| {
        let (sender, receiver) = mpsc::sync_channel::<Request>(16);
        std::thread::Builder::new().name("shellcanvas-clipboard".into()).spawn(move || unsafe {
            let initialization = OleInitialize(None);
            let mut current: Option<(IDataObject, u32)> = None;
            loop {
                while let Ok(request) = receiver.try_recv() {
                    if let Some((object, _)) = &current { if OleIsCurrentClipboard(object).is_err() { current = None; } }
                    let offer = match request {
                        Request::Publish(offer) => offer,
                        Request::Sequence(reply) => {
                            // Delayed rendering changes the OS serial without replacing
                            // our IDataObject. Keep its original selection identity.
                            let _ = reply.send(current.as_ref().map(|(_, sequence)| *sequence).unwrap_or_else(crate::windows_file_input::sequence));
                            continue;
                        }
                    };
                    let result = match &initialization {
                        Ok(()) if windows::Win32::System::DataExchange::GetClipboardSequenceNumber() != offer.sequence => Err("The clipboard changed while preparing files. Copy again if needed.".into()),
                        Ok(()) => {
                            let object: IDataObject = VirtualFiles::new(offer.sources).into();
                            OleSetClipboard(&object).map(|()| { let sequence = crate::windows_file_input::sequence(); current = Some((object, sequence)); sequence }).map_err(|error| error.to_string())
                        },
                        Err(error) => Err(error.to_string()),
                    };
                    let _ = offer.reply.send(result);
                }
                let mut message = MSG::default();
                while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() { let _ = TranslateMessage(&message); DispatchMessageW(&message); }
                if let Some((object, _)) = &current { if OleIsCurrentClipboard(object).is_err() { current = None; } }
                std::thread::sleep(Duration::from_millis(10));
            }
        }).map_err(|error| error.to_string())?;
        Ok(sender)
    }).as_ref().map_err(Clone::clone)
}
pub async fn current_sequence() -> std::result::Result<u32, String> {
    let (reply, result) = tokio::sync::oneshot::channel();
    sender()?
        .try_send(Request::Sequence(reply))
        .map_err(|_| "Clipboard is busy. Try again.".to_string())?;
    result
        .await
        .map_err(|_| "Clipboard worker stopped".to_string())
}
pub async fn publish(
    sources: impl Into<Sources>,
    sequence: u32,
) -> std::result::Result<u32, String> {
    let sources = sources.into();
    if sources.len() > i32::MAX as usize {
        return Err("Clipboard exceeds the Windows file-index range".into());
    }
    let (reply, result) = tokio::sync::oneshot::channel();
    sender()?
        .try_send(Request::Publish(Offer {
            sources,
            sequence,
            reply,
        }))
        .map_err(|_| "Clipboard is busy. Try copying again.".to_string())?;
    result
        .await
        .map_err(|_| "Clipboard worker stopped".to_string())?
}
