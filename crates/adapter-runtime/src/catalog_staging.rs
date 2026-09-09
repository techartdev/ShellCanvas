// SPDX-License-Identifier: MPL-2.0
//! The caller holds catalog.lock during creation and collection. Copying/review
//! retains a separate OS lease, so other processes can collect without waiting
//! for a user decision or a large package copy.
use anyhow::{bail, Result};
use std::{
    fs::{self, File, OpenOptions},
    path::Path,
};
use tempfile::TempDir;

pub(crate) struct Staging {
    // Release the lease before TempDir tries to remove the directory on Windows.
    lease: Option<File>,
    directory: TempDir,
}
impl Staging {
    pub(crate) fn new(root: &Path) -> Result<Self> {
        let staging = root.join("staging");
        fs::create_dir_all(&staging)?;
        if !plain_directory(&staging)?
            || staging.canonicalize()?.parent() != Some(root.canonicalize()?.as_path())
        {
            bail!("Adapter staging must be a directory inside its catalog");
        }
        let directory = tempfile::Builder::new()
            .prefix("review-v1-")
            .rand_bytes(16)
            .tempdir_in(staging)?;
        let lease = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(directory.path().join("lease.lock"))?;
        lease.lock()?;
        lease.sync_all()?;
        Ok(Self {
            lease: Some(lease),
            directory,
        })
    }
    pub(crate) fn path(&self) -> &Path {
        self.directory.path()
    }
    /// Windows cannot rename the staging directory while this file is open.
    /// The install caller must hold catalog.lock until rename and publication
    /// finish, so recovery cannot race this handoff from review to generation.
    pub(crate) fn release_for_install(&mut self) {
        drop(self.lease.take());
    }
}

fn plain_directory(path: &Path) -> Result<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    Ok(metadata.is_dir() && !is_link(&metadata))
}
fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        } // reparse point
    }
    metadata.file_type().is_symlink()
}
fn owned_name(name: &str) -> bool {
    name.strip_prefix("review-v1-").is_some_and(|suffix| {
        suffix.len() == 16 && suffix.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}
pub(crate) fn collect(root: &Path) -> Result<usize> {
    let staging = root.join("staging");
    match fs::symlink_metadata(&staging) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error.into()),
        Ok(_) => {}
    }
    if !plain_directory(&staging)? {
        return Ok(0);
    }
    let staging = staging.canonicalize()?;
    if staging.parent() != Some(root.canonicalize()?.as_path()) {
        return Ok(0);
    }
    let mut removed = 0;
    for item in fs::read_dir(&staging)? {
        let item = item?;
        if !owned_name(&item.file_name().to_string_lossy()) || !plain_directory(&item.path())? {
            continue;
        }
        let target = match item.path().canonicalize() {
            Ok(target) => target,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        if target.parent() != Some(staging.as_path()) {
            continue;
        }
        let lock_path = target.join("lease.lock");
        let lock = match fs::symlink_metadata(&lock_path) {
            Ok(metadata) if metadata.is_file() && !is_link(&metadata) => {
                OpenOptions::new().read(true).write(true).open(&lock_path)
            }
            // Creation of directory and lease is serialized by catalog.lock.
            // A missing lease in our versioned directory can only be abandoned
            // construction, not a live creator between these two operations.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(&lock_path),
            _ => continue,
        };
        let Ok(lock) = lock else {
            continue;
        };
        if lock.try_lock().is_err() {
            continue;
        }
        drop(lock); // catalog.lock prevents a new creator/review from acquiring it.
        if fs::remove_dir_all(&target).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lease_protects_staging_before_any_payload_exists_and_drop_cleans_it() {
        let root = tempfile::tempdir().unwrap();
        let stage = Staging::new(root.path()).unwrap();
        let path = stage.path().to_owned();
        assert!(owned_name(path.file_name().unwrap().to_str().unwrap()));
        assert!(!path.join("payload").exists());
        assert_eq!(collect(root.path()).unwrap(), 0);
        drop(stage);
        assert!(!path.exists());
    }
    #[test]
    fn recovery_handles_incomplete_construction_but_preserves_unknown_directories() {
        let root = tempfile::tempdir().unwrap();
        let staging = root.path().join("staging");
        fs::create_dir(&staging).unwrap();
        for name in [
            "review-v1-0123456789abcdef",
            "review-v1-fedcba9876543210",
            "review-legacy",
            "unrelated",
            "review-v2-0123456789abcdef",
        ] {
            fs::create_dir(staging.join(name)).unwrap();
        }
        fs::write(staging.join("review-v1-fedcba9876543210/lease.lock"), b"").unwrap();
        fs::write(
            staging.join("review-v1-fedcba9876543210/partial.bin"),
            b"incomplete",
        )
        .unwrap();
        assert_eq!(collect(root.path()).unwrap(), 2);
        assert_eq!(fs::read_dir(staging).unwrap().count(), 3);
        assert_eq!(collect(root.path()).unwrap(), 0);
    }
}
