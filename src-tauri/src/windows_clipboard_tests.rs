// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::clipboard_stream::Source;
use async_trait::async_trait;
use shellcanvas_core::{
    FileEntry, FileLocation, FileTransferService, TransferFile, TransferReader, TransferWriter,
    TRANSFER_CHUNK,
};
use std::sync::{atomic::AtomicUsize, Arc};
use windows::core::Interface;
struct Memory {
    bytes: Vec<u8>,
    opens: AtomicUsize,
    reads: AtomicUsize,
    finishes: AtomicUsize,
    aborts: AtomicUsize,
    changed: AtomicBool,
}
struct Reader {
    memory: Arc<Memory>,
    position: usize,
}
#[async_trait]
impl TransferReader for Reader {
    fn file(&self) -> TransferFile {
        TransferFile {
            location: FileLocation {
                path: "file@opaque".into(),
                name: "test.bin".into(),
                parent: None,
            },
            size: self.memory.bytes.len() as u64,
        }
    }
    async fn read(&mut self) -> anyhow::Result<Vec<u8>> {
        self.memory.reads.fetch_add(1, Ordering::SeqCst);
        let end = (self.position + TRANSFER_CHUNK).min(self.memory.bytes.len());
        let data = self.memory.bytes[self.position..end].to_vec();
        self.position = end;
        Ok(data)
    }
    async fn finish(&mut self) -> anyhow::Result<()> {
        if self.memory.changed.load(Ordering::SeqCst) {
            anyhow::bail!("Source changed");
        }
        self.memory.finishes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn abort(&mut self) -> anyhow::Result<()> {
        self.memory.aborts.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
#[async_trait]
impl FileTransferService for Memory {
    async fn download(
        self: Arc<Self>,
        _: &str,
        revision: &str,
    ) -> anyhow::Result<Box<dyn TransferReader>> {
        if revision != "revision-1" {
            anyhow::bail!("Wrong revision");
        }
        self.opens.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(Reader {
            memory: self,
            position: 0,
        }))
    }
    async fn upload(
        self: Arc<Self>,
        _: &str,
        _: &str,
        _: u64,
    ) -> anyhow::Result<Box<dyn TransferWriter>> {
        anyhow::bail!("Read-only fixture")
    }
}
fn fixture(size: usize) -> (tokio::runtime::Runtime, Arc<Memory>, Source) {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let memory = Arc::new(Memory {
        bytes: (0..size).map(|i| (i % 251) as u8).collect(),
        opens: AtomicUsize::new(0),
        reads: AtomicUsize::new(0),
        finishes: AtomicUsize::new(0),
        aborts: AtomicUsize::new(0),
        changed: AtomicBool::new(false),
    });
    let source = Source {
        display_path: "Notes \u{1f30d}.bin".into(),
        entry: FileEntry {
            path: "file@opaque".into(),
            name: "Notes 🌍.bin".into(),
            kind: "file".into(),
            size: size as u64,
            modified: None,
            revision: "revision-1".into(),
        },
        service: memory.clone(),
        runtime: runtime.handle().clone(),
    };
    (runtime, memory, source)
}
#[test]
fn ten_thousand_catalog_descriptors_open_only_the_requested_file() {
    use crate::transfers::catalog::Catalog;
    let (runtime, memory, source) = fixture(37);
    let catalog = Arc::new(Catalog::new(true).unwrap());
    for batch in 0..100 {
        catalog
            .add(
                None,
                (0..100)
                    .map(|offset| {
                        let id = batch * 100 + offset;
                        let mut entry = source.entry.clone();
                        entry.path = format!("opaque@{id}");
                        entry.name = format!("file-{id}.bin");
                        (entry, None)
                    })
                    .collect(),
            )
            .unwrap();
    }
    unsafe {
        OleInitialize(None).unwrap();
        let sources = Sources::catalogs(vec![catalog], memory.clone(), runtime.handle().clone());
        let object = VirtualFiles::new(sources);
        let descriptors = object.descriptors;
        let contents = object.contents;
        let object: IDataObject = object.into();
        let mut medium = object
            .GetData(&format(descriptors, TYMED_HGLOBAL, -1))
            .unwrap();
        let bytes = GlobalLock(medium.u.hGlobal).cast::<u8>();
        assert_eq!(ptr::read_unaligned(bytes.cast::<u32>()), 10_000);
        let _ = GlobalUnlock(medium.u.hGlobal);
        ReleaseStgMedium(&mut medium);
        assert_eq!(memory.opens.load(Ordering::SeqCst), 0);
        let mut medium = object
            .GetData(&format(contents, TYMED_ISTREAM, 9999))
            .unwrap();
        let stream = medium.u.pstm.as_ref().unwrap();
        let mut data = [0u8; 37];
        let mut read = 0;
        stream
            .Read(data.as_mut_ptr().cast(), 37, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(memory.opens.load(Ordering::SeqCst), 1);
        assert_eq!(data.as_slice(), memory.bytes);
        ReleaseStgMedium(&mut medium);
        OleUninitialize();
    }
}
#[test]
fn folder_descriptors_keep_empty_directories_and_nested_stream_indices() {
    let (_runtime, memory, mut file) = fixture(37);
    file.display_path = "Folder\\Nested\\Notes.bin".into();
    let mut root = file.clone();
    root.entry.kind = "directory".into();
    root.entry.size = 0;
    root.display_path = "Folder".into();
    let mut empty = root.clone();
    empty.display_path = "Folder\\Empty".into();
    let mut nested = root.clone();
    nested.display_path = "Folder\\Nested".into();
    unsafe {
        OleInitialize(None).unwrap();
        let object = VirtualFiles::new(vec![root, empty, nested, file]);
        let descriptors = object.descriptors;
        let contents = object.contents;
        let object: IDataObject = object.into();
        let mut medium = object
            .GetData(&format(descriptors, TYMED_HGLOBAL, -1))
            .unwrap();
        let bytes = GlobalLock(medium.u.hGlobal).cast::<u8>();
        assert_eq!(ptr::read_unaligned(bytes.cast::<u32>()), 4);
        for (i, expected) in [
            "Folder",
            "Folder\\Empty",
            "Folder\\Nested",
            "Folder\\Nested\\Notes.bin",
        ]
        .iter()
        .enumerate()
        {
            let descriptor = ptr::read_unaligned(
                bytes
                    .add(4 + i * size_of::<FILEDESCRIPTORW>())
                    .cast::<FILEDESCRIPTORW>(),
            );
            let name = descriptor.cFileName;
            assert_eq!(
                String::from_utf16_lossy(&name[..name.iter().position(|n| *n == 0).unwrap()]),
                *expected
            );
            let attrs = descriptor.dwFileAttributes;
            assert_eq!(attrs, if i < 3 { 0x10 } else { 0x80 });
        }
        let _ = GlobalUnlock(medium.u.hGlobal);
        ReleaseStgMedium(&mut medium);
        assert_eq!(memory.opens.load(Ordering::SeqCst), 0);
        assert!(object.GetData(&format(contents, TYMED_ISTREAM, 0)).is_err());
        let mut medium = object.GetData(&format(contents, TYMED_ISTREAM, 3)).unwrap();
        let stream = medium.u.pstm.as_ref().unwrap();
        let mut data = [0u8; 37];
        let mut read = 0;
        stream
            .Read(data.as_mut_ptr().cast(), 37, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(read, 37);
        assert_eq!(data.as_slice(), memory.bytes);
        ReleaseStgMedium(&mut medium);
        OleUninitialize();
    }
}
#[test]
fn virtual_descriptors_are_metadata_only_and_contents_stream_exact_bytes() {
    let (_runtime, memory, source) = fixture(TRANSFER_CHUNK * 3 + 17);
    unsafe {
        OleInitialize(None).unwrap();
        let object = VirtualFiles::new(vec![source]);
        let descriptors = object.descriptors;
        let contents = object.contents;
        let object: IDataObject = object.into();
        let mut medium = object
            .GetData(&format(descriptors, TYMED_HGLOBAL, -1))
            .unwrap();
        let bytes = GlobalLock(medium.u.hGlobal).cast::<u8>();
        assert_eq!(ptr::read_unaligned(bytes.cast::<u32>()), 1);
        let descriptor = ptr::read_unaligned(bytes.add(4).cast::<FILEDESCRIPTORW>());
        let filename = descriptor.cFileName;
        assert_eq!(
            String::from_utf16_lossy(&filename[..filename.iter().position(|c| *c == 0).unwrap()]),
            "Notes 🌍.bin"
        );
        assert_eq!(memory.opens.load(Ordering::SeqCst), 0);
        let _ = GlobalUnlock(medium.u.hGlobal);
        ReleaseStgMedium(&mut medium);
        let mut medium = object.GetData(&format(contents, TYMED_ISTREAM, 0)).unwrap();
        assert_eq!(memory.opens.load(Ordering::SeqCst), 0);
        let stream = medium.u.pstm.as_ref().unwrap();
        let mut result = Vec::new();
        loop {
            let mut buffer = [0u8; 7777];
            let mut read = 0;
            stream
                .Read(
                    buffer.as_mut_ptr().cast(),
                    buffer.len() as u32,
                    Some(&mut read),
                )
                .ok()
                .unwrap();
            result.extend_from_slice(&buffer[..read as usize]);
            if read == 0 {
                break;
            }
        }
        assert_eq!(result, memory.bytes);
        assert_eq!(memory.finishes.load(Ordering::SeqCst), 1);
        let mut size = STATSTG::default();
        stream.Stat(&mut size, STATFLAG_NONAME).unwrap();
        assert_eq!(size.cbSize, memory.bytes.len() as u64);
        ReleaseStgMedium(&mut medium);
        drop(object);
        OleUninitialize();
    }
}
#[test]
fn seeks_clones_and_failed_final_validation_do_not_require_a_local_cache() {
    let (_runtime, memory, source) = fixture(TRANSFER_CHUNK * 2 + 1);
    let mut stream = RemoteStream::new(source.clone());
    let mut small = [0u8; 19];
    stream.seek(33100, 0).unwrap();
    stream.read(&mut small).unwrap();
    assert_eq!(small, memory.bytes[33100..33119]);
    stream.seek(3, 0).unwrap();
    stream.read(&mut small).unwrap();
    assert_eq!(small, memory.bytes[3..22]);
    assert!(stream.seek(-1, 0).is_err());
    memory.changed.store(true, Ordering::SeqCst);
    let mut failed = RemoteStream::new(source);
    assert!(failed.read(&mut vec![0; memory.bytes.len()]).is_err());
    assert!(failed.read(&mut small).is_err());
}
#[test]
fn empty_files_are_verified_and_streams_reject_writes_and_invalid_formats() {
    let (_runtime, memory, source) = fixture(0);
    unsafe {
        OleInitialize(None).unwrap();
        let object = VirtualFiles::new(vec![source]);
        let contents = object.contents;
        let object: IDataObject = object.into();
        assert!(object.GetData(&format(contents, TYMED_ISTREAM, 9)).is_err());
        let mut medium = object.GetData(&format(contents, TYMED_ISTREAM, 0)).unwrap();
        assert_eq!(memory.finishes.load(Ordering::SeqCst), 1);
        let stream = medium.u.pstm.as_ref().unwrap();
        assert!(stream.Write(ptr::null(), 0, None).is_err());
        let clone = stream.Clone().unwrap();
        let mut read = 99;
        assert!(clone.Read(ptr::null_mut(), 1, Some(&mut read)).is_err());
        assert_eq!(read, 0);
        let asynchronous: IDataObjectAsyncCapability = object.cast().unwrap();
        assert!(asynchronous.GetAsyncMode().unwrap().as_bool());
        drop(clone);
        ReleaseStgMedium(&mut medium);
        drop(asynchronous);
        drop(object);
        OleUninitialize();
    }
}

/// Explicit opt-in probe for Explorer. It only serves generated bytes; no host access.
#[test]
#[ignore]
fn explorer_clipboard_probe() {
    let (runtime, memory, first) = fixture(8 * 1024 * 1024 + 17);
    let mut second = first.clone();
    second.entry.name = "Second file.bin".into();
    second.display_path = second.entry.name.clone();
    let sources = if std::env::var_os("SHELLCANVAS_FOLDER_PROBE").is_some() {
        let mut first = first;
        first.display_path = "Folder probe\\Nested\\First.bin".into();
        second.display_path = "Folder probe\\Second.bin".into();
        let mut root = first.clone();
        root.entry.kind = "directory".into();
        root.entry.size = 0;
        root.display_path = "Folder probe".into();
        let mut nested = root.clone();
        nested.display_path = "Folder probe\\Nested".into();
        let mut empty = root.clone();
        empty.display_path = "Folder probe\\Empty".into();
        vec![root, nested, empty, first, second]
    } else {
        vec![first, second]
    };
    // Exercise the same disk-backed catalog used by production clipboard Copy.
    let catalog = Arc::new(crate::transfers::catalog::Catalog::new(true).unwrap());
    let mut parents = std::collections::HashMap::new();
    for (index, source) in sources.into_iter().enumerate() {
        let (parent, name) = source
            .display_path
            .rsplit_once('\\')
            .map(|(parent, name)| (parents.get(parent).cloned(), name.to_string()))
            .unwrap_or((None, source.display_path.clone()));
        let mut entry = source.entry;
        entry.name = name;
        entry.path = format!("probe@{index}");
        catalog.add(parent.as_ref(), vec![(entry, None)]).unwrap();
        parents.insert(source.display_path, catalog.get(catalog.len()).unwrap());
    }
    let sources = Sources::catalogs(vec![catalog], memory.clone(), runtime.handle().clone());
    runtime
        .block_on(publish_selection(
            sources,
            unsafe { windows::Win32::System::DataExchange::GetClipboardSequenceNumber() },
            None,
        ))
        .unwrap();
    eprintln!("EXPLORER_READY: two generated files; expected size 8388625 each. Ctrl+V into an owned test folder. Opens before Paste: {}", memory.opens.load(Ordering::SeqCst));
    for _ in 0..180 {
        std::thread::sleep(Duration::from_secs(1));
        if memory.finishes.load(Ordering::SeqCst) >= 2 {
            eprintln!(
                "EXPLORER_COMPLETE: {} verified file streams",
                memory.finishes.load(Ordering::SeqCst)
            );
            // Keep the COM apartment alive until Explorer receives the final Read reply.
            std::thread::sleep(Duration::from_secs(10));
            return;
        }
    }
    panic!("Explorer probe timed out before two completed streams");
}
