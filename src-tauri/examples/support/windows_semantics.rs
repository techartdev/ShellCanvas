// SPDX-License-Identifier: MPL-2.0
//! Identical Windows API operations for local NTFS and a mapped test directory.
//! No Linux/POSIX expectations and no remote helper.
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    os::windows::fs::OpenOptionsExt,
    path::Path,
};

pub fn check(root: &Path) -> Vec<(String, Result<(), String>)> {
    let mut results = Vec::new();
    for case in [
        "closed-rename",
        "closed-delete",
        "shared-read-write",
        "rename-shared",
        "rename-denied",
        "exclusive-denied",
    ] {
        let source = root.join(format!("{case}.txt"));
        let target = root.join(format!("{case}-renamed.txt"));
        let outcome = std::panic::catch_unwind(|| -> std::io::Result<()> {
            fs::write(&source, b"original")?;
            match case {
                "closed-rename" => {
                    fs::rename(&source, &target)?;
                    assert_eq!(fs::read(&target)?, b"original");
                }
                "closed-delete" => {
                    fs::remove_file(&source)?;
                    assert!(!source.exists());
                }
                "shared-read-write" => {
                    let mut writer = fs::OpenOptions::new()
                        .read(true)
                        .write(true)
                        .share_mode(7)
                        .open(&source)?;
                    writer.write_all(b"modified")?;
                    writer.sync_all()?;
                    assert_eq!(fs::read(&source)?, b"modified");
                }
                "rename-shared" => {
                    let mut reader = fs::OpenOptions::new()
                        .read(true)
                        .share_mode(7)
                        .open(&source)?;
                    fs::rename(&source, &target)?;
                    let mut bytes = Vec::new();
                    reader.read_to_end(&mut bytes)?;
                    assert_eq!(bytes, b"original");
                    assert_eq!(fs::read(&target)?, b"original");
                }
                "rename-denied" => {
                    let mut reader = fs::OpenOptions::new()
                        .read(true)
                        .share_mode(3)
                        .open(&source)?;
                    let error = fs::rename(&source, &target)
                        .expect_err("Rename bypassed a no-delete-sharing handle");
                    // SFTP v3 may report a generic failure instead of exposing
                    // Windows error 32. Record that separately from enforcing
                    // refusal and preservation of the original object.
                    println!(
                        "{case}: refused with Windows error {:?}",
                        error.raw_os_error()
                    );
                    let mut bytes = Vec::new();
                    reader.read_to_end(&mut bytes)?;
                    assert_eq!(bytes, b"original");
                    assert!(!target.exists());
                }
                "exclusive-denied" => {
                    let mut writer = fs::OpenOptions::new()
                        .read(true)
                        .write(true)
                        .share_mode(0)
                        .open(&source)?;
                    let error = fs::read(&source).expect_err("Read bypassed an exclusive handle");
                    println!(
                        "{case}: refused with Windows error {:?}",
                        error.raw_os_error()
                    );
                    writer.seek(SeekFrom::Start(0))?;
                    let mut bytes = Vec::new();
                    writer.read_to_end(&mut bytes)?;
                    assert_eq!(bytes, b"original");
                }
                _ => unreachable!(),
            }
            Ok(())
        })
        .map_err(|panic| {
            let reason = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_else(|| "Windows semantics assertion failed".into());
            format!("ASSERTION: {reason}")
        })
        .and_then(|outcome| {
            outcome.map_err(|e| format!("{e} (Windows error {:?})", e.raw_os_error()))
        });
        // All case handles have closed before cleanup. Never touch anything
        // outside these exact, newly created fixture paths.
        for path in [&source, &target] {
            if path.exists() {
                let _ = fs::remove_file(path);
            }
        }
        results.push((case.to_owned(), outcome));
    }
    results
}

#[cfg(test)]
mod tests {
    #[test]
    fn native_windows_sharing_baseline() {
        let root = std::env::temp_dir().join(format!("shellcanvas-sharing-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let results = super::check(&root);
        std::fs::remove_dir(&root).unwrap();
        for (case, result) in results {
            println!("{case}: {result:?}");
            assert!(result.is_ok(), "{case}: {result:?}");
        }
    }
}
