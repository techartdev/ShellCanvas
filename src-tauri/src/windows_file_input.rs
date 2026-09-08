// SPDX-License-Identifier: MPL-2.0
//! Read Explorer's file clipboard only after an explicit Paste. Never pass paths to JS.
use std::path::PathBuf;
use windows::Win32::{
    System::{DataExchange::*, Ole::CF_HDROP},
    UI::Shell::{DragQueryFileW, HDROP},
};

pub fn sequence() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}

struct Clipboard;
impl Drop for Clipboard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

pub fn files() -> Result<Option<Vec<PathBuf>>, String> {
    unsafe {
        OpenClipboard(None).map_err(|_| "The clipboard is busy. Try Paste again.".to_string())?;
        let _clipboard = Clipboard;
        if IsClipboardFormatAvailable(CF_HDROP.0 as u32).is_err() {
            return Ok(None);
        }
        let handle = GetClipboardData(CF_HDROP.0 as u32).map_err(|e| e.to_string())?;
        read_drop(HDROP(handle.0)).map(Some)
    }
}

// Handle remains owned by the clipboard (or the isolated test allocation).
unsafe fn read_drop(handle: HDROP) -> Result<Vec<PathBuf>, String> {
    let count = DragQueryFileW(handle, u32::MAX, None);
    if count == 0 || count > 16 {
        return Err("Copy up to 16 regular files in Explorer, then paste here.".into());
    }
    let mut paths = Vec::new();
    for index in 0..count {
        let length = DragQueryFileW(handle, index, None);
        if length == 0 || length > 32767 {
            return Err("Invalid clipboard filename.".into());
        }
        let mut name = vec![0u16; length as usize + 1];
        if DragQueryFileW(handle, index, Some(&mut name)) != length {
            return Err("The clipboard file list changed. Copy again.".into());
        }
        let name = String::from_utf16(&name[..length as usize])
            .map_err(|_| "Clipboard filename is not valid Unicode")?;
        let path = PathBuf::from(name);
        if !path.is_absolute() {
            return Err("Clipboard files must have absolute locations.".into());
        }
        paths.push(path);
    }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::{Foundation::GlobalFree, System::Memory::*};
    fn decode(names: &[&str]) -> Result<Vec<PathBuf>, String> {
        // DROPFILES: 20-byte header, UTF-16 double-null terminated file list.
        let mut bytes = vec![0u8; 20];
        bytes[..4].copy_from_slice(&20u32.to_le_bytes());
        bytes[16..20].copy_from_slice(&1u32.to_le_bytes());
        for name in names {
            for unit in name.encode_utf16().chain([0]) {
                bytes.extend(unit.to_le_bytes());
            }
        }
        bytes.extend([0, 0]);
        unsafe {
            let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).unwrap();
            let output = GlobalLock(memory);
            assert!(!output.is_null());
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), output.cast(), bytes.len());
            let _ = GlobalUnlock(memory);
            let result = read_drop(HDROP(memory.0));
            let _ = GlobalFree(Some(memory));
            result
        }
    }
    #[test]
    fn decodes_unicode_multiple_files_and_refuses_relative_or_oversized_batches() {
        assert_eq!(
            decode(&[r"C:\test\Notes 🌍.txt", r"D:\two.bin"]).unwrap(),
            vec![
                PathBuf::from(r"C:\test\Notes 🌍.txt"),
                PathBuf::from(r"D:\two.bin")
            ]
        );
        assert!(decode(&[r"relative.txt"]).is_err());
        assert!(decode(&[r"C:\x"; 17]).is_err());
        assert!(decode(&[]).is_err());
    }
}
