// SPDX-License-Identifier: MPL-2.0
//! Read OS mount tables without touching a potentially disconnected filesystem.
//! No driver dependency and no unmount/force operation lives here.
use std::path::Path;

#[cfg(windows)]
pub(crate) fn available_drive_letters() -> Result<Vec<String>, String> {
    let mask = unsafe { windows::Win32::Storage::FileSystem::GetLogicalDrives() };
    if mask == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let mut available = Vec::new();
    for letter in (b'D'..=b'Z').rev() {
        let target = format!("{}:", char::from(letter));
        if mask & (1 << (letter - b'A')) == 0 && !network_drive_reserved(&target)? {
            available.push(target);
        }
    }
    Ok(available)
}

#[cfg(windows)]
fn network_drive_reserved(target: &str) -> Result<bool, String> {
    use windows::{core::HSTRING, Win32::NetworkManagement::WNet::WNetGetConnectionW};
    let mut remote = [0u16; 256];
    let mut length = remote.len() as u32;
    let status = unsafe {
        WNetGetConnectionW(
            &HSTRING::from(target),
            Some(windows::core::PWSTR(remote.as_mut_ptr())),
            &mut length,
        )
    };
    network_connection_reserved(status.0)
}

#[cfg(windows)]
fn network_connection_reserved(status: u32) -> Result<bool, String> {
    use windows::Win32::Foundation::{
        ERROR_CONNECTION_UNAVAIL, ERROR_MORE_DATA, ERROR_NOT_CONNECTED, NO_ERROR,
    };
    match status {
        s if s == NO_ERROR.0 || s == ERROR_MORE_DATA.0 || s == ERROR_CONNECTION_UNAVAIL.0 => {
            Ok(true)
        }
        s if s == ERROR_NOT_CONNECTED.0 => Ok(false),
        other => Err(format!(
            "Unable to check reserved network drives: {}",
            std::io::Error::from_raw_os_error(other as i32)
        )),
    }
}

/// Reservations include remembered disconnected network drives. Cleanup checks
/// deliberately use occupied() instead: a remembered drive is not our live mount.
pub(crate) fn reserved_for_attachment(target: &Path) -> Result<bool, String> {
    if occupied(target)? {
        return Ok(true);
    }
    #[cfg(windows)]
    return network_drive_reserved(target.to_str().ok_or("Invalid local drive")?);
    #[cfg(not(windows))]
    Ok(false)
}

#[cfg(windows)]
pub(crate) fn occupied(target: &Path) -> Result<bool, String> {
    let value = target.to_str().ok_or("Invalid local drive")?.as_bytes();
    if value.len() != 2 || !value[0].is_ascii_uppercase() || value[1] != b':' {
        return Err("Expected a local drive letter".into());
    }
    let mask = unsafe { windows::Win32::Storage::FileSystem::GetLogicalDrives() };
    if mask == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(mask & (1 << (value[0] - b'A')) != 0)
}

#[cfg(target_os = "linux")]
pub(crate) fn occupied(target: &Path) -> Result<bool, String> {
    use std::os::unix::ffi::OsStrExt;
    let mounts = std::fs::read("/proc/self/mountinfo").map_err(|e| e.to_string())?;
    linux_occupied(&mounts, target.as_os_str().as_bytes())
}

#[cfg(any(target_os = "linux", test))]
fn linux_occupied(table: &[u8], target: &[u8]) -> Result<bool, String> {
    let mut has_entries = false;
    for line in table.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
        has_entries = true;
        let fields: Vec<_> = line.split(|b| *b == b' ').collect();
        if fields.len() < 10 || !fields[6..].contains(&b"-".as_slice()) {
            return Err("Unable to interpret the local mount table".into());
        }
        let mut decoded = Vec::new();
        let mut input = fields[4];
        while !input.is_empty() {
            if input[0] == b'\\' {
                let code = input.get(1..4).ok_or("Invalid mount table escape")?;
                let byte = match code {
                    b"040" => b' ',
                    b"011" => b'\t',
                    b"012" => b'\n',
                    b"134" => b'\\',
                    _ => return Err("Invalid mount table escape".into()),
                };
                decoded.push(byte);
                input = &input[4..];
            } else {
                decoded.push(input[0]);
                input = &input[1..];
            }
        }
        if decoded == target {
            return Ok(true);
        }
    }
    if !has_entries {
        return Err("Local mount table is empty".into());
    }
    Ok(false)
}

#[cfg(target_os = "macos")]
pub(crate) fn occupied(target: &Path) -> Result<bool, String> {
    use std::{
        ffi::CStr,
        mem::{size_of, MaybeUninit},
        os::unix::ffi::OsStrExt,
    };
    // getfsstat owns no global buffer (unlike getmntinfo); NOWAIT avoids querying
    // a disconnected FUSE mount. Retry a growing table, never assume truncation is absence.
    let mut capacity = 16usize;
    for _ in 0..5 {
        let mut entries = Vec::<MaybeUninit<libc::statfs>>::with_capacity(capacity);
        let bytes = capacity
            .checked_mul(size_of::<libc::statfs>())
            .ok_or("Mount table overflow")?;
        let bytes = i32::try_from(bytes).map_err(|_| "Mount table too large")?;
        let count =
            unsafe { libc::getfsstat(entries.as_mut_ptr().cast(), bytes, libc::MNT_NOWAIT) };
        if count < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let count = count as usize;
        if count >= capacity {
            capacity = capacity.checked_mul(2).ok_or("Mount table overflow")?;
            continue;
        }
        if count == 0 {
            return Err("Local mount table is empty".into());
        }
        // The syscall initialized exactly count entries in our allocated buffer.
        unsafe {
            entries.set_len(count);
        }
        for entry in entries {
            let entry = unsafe { entry.assume_init() };
            let name = unsafe { CStr::from_ptr(entry.f_mntonname.as_ptr()) };
            if name.to_bytes() == target.as_os_str().as_bytes() {
                return Ok(true);
            }
        }
        return Ok(false);
    }
    Err("Local mount table changed while checking cleanup; retry.".into())
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub(crate) fn occupied(_: &Path) -> Result<bool, String> {
    Err("Local mount verification is unavailable on this system".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn disconnected_network_connections_still_reserve_the_letter() {
        use windows::Win32::Foundation::*;
        for status in [NO_ERROR, ERROR_MORE_DATA, ERROR_CONNECTION_UNAVAIL] {
            assert_eq!(network_connection_reserved(status.0), Ok(true));
        }
        assert_eq!(
            network_connection_reserved(ERROR_NOT_CONNECTED.0),
            Ok(false)
        );
        assert!(network_connection_reserved(ERROR_ACCESS_DENIED.0).is_err());
        let available = available_drive_letters().expect("Read local drive reservations");
        for letter in &available {
            assert!(!reserved_for_attachment(Path::new(letter)).unwrap());
        }
        println!("Available attachment letters: {available:?}");
    }
    #[test]
    fn native_system_volume_is_present_without_filesystem_io() {
        #[cfg(windows)]
        let target = std::path::PathBuf::from(std::env::var_os("SystemDrive").unwrap());
        #[cfg(not(windows))]
        let target = std::path::PathBuf::from("/");
        assert_eq!(occupied(&target), Ok(true));
    }
    #[test]
    fn linux_mount_table_checks_exact_paths_and_decodes_names() {
        let table = b"20 1 0:1 / / rw - ext4 /dev/root rw\n21 20 0:2 / /tmp/my\\040mount\\134folder rw - fuse.shellcanvas bridge rw\n";
        assert_eq!(linux_occupied(table, b"/tmp/my mount\\folder"), Ok(true));
        assert_eq!(linux_occupied(table, b"/tmp/my mount"), Ok(false));
        assert_eq!(linux_occupied(table, b"/tmp/missing"), Ok(false));
        assert!(linux_occupied(b"", b"/tmp").is_err());
        assert!(linux_occupied(b"\n", b"/tmp").is_err());
        assert!(linux_occupied(b"invalid", b"/tmp").is_err());
        assert!(linux_occupied(b"21 20 0:2 / /tmp/\\999 rw - fuse x rw", b"/tmp").is_err());
    }
}
