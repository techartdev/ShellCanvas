// SPDX-License-Identifier: MPL-2.0
use crate::{text::validate_path, SftpTextFiles};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use russh_sftp::{
    client::error::Error as SftpError,
    protocol::{FileAttributes, StatusCode},
};
use sha2::{Digest, Sha256};

/// A listing precondition, not a content hash or an atomic compare-and-swap token.
pub fn entry_revision(attrs: &FileAttributes) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            format!(
                "{:?}:{:?}:{:?}:{:?}:{:?}",
                attrs.size, attrs.uid, attrs.gid, attrs.permissions, attrs.mtime
            )
            .as_bytes()
        )
    )
}
pub fn validate_name(name: &str) -> Result<()> {
    if name.trim().is_empty()
        || matches!(name, "." | "..")
        || name.len() > 255
        || name.contains('/')
        || name.chars().any(char::is_control)
    {
        bail!("Enter one file or folder name, without slashes or control characters (up to 255 UTF-8 bytes).");
    }
    Ok(())
}
#[async_trait]
pub trait FileMutationService: Send + Sync {
    async fn make_directory(&self, parent: &str, name: &str) -> Result<String>;
    async fn rename_entry(&self, path: &str, name: &str, revision: &str) -> Result<String>;
    async fn remove_entry(&self, path: &str, revision: &str) -> Result<()>;
}
impl SftpTextFiles {
    pub(crate) async fn child_path(&self, parent: &str, name: &str) -> Result<String> {
        validate_path(parent)?;
        validate_name(name)?;
        let resolved = self
            .raw
            .realpath(parent)
            .await?
            .files
            .into_iter()
            .next()
            .context("Server did not resolve the parent folder")?
            .filename;
        if !self.raw.stat(&resolved).await?.attrs.is_dir() {
            bail!("Choose an existing parent folder.");
        }
        let path = format!("{}/{name}", resolved.trim_end_matches('/'));
        validate_path(&path)?;
        Ok(path)
    }
    pub(crate) async fn require_absent(&self, path: &str) -> Result<()> {
        match self.raw.lstat(path).await {
            Ok(_) => bail!("An item already exists at this destination. Choose a different name; nothing was replaced."),
            Err(SftpError::Status(s)) if s.status_code == StatusCode::NoSuchFile => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
    async fn checked_entry(&self, path: &str, revision: &str) -> Result<FileAttributes> {
        validate_path(path)?;
        let (parent, name) = path.rsplit_once('/').context("Unsupported remote path")?;
        let resolved = self
            .child_path(if parent.is_empty() { "/" } else { parent }, name)
            .await?;
        if resolved != path {
            bail!("CONFLICT: The parent folder changed. Refresh before changing this item.");
        }
        let attrs = self.raw.lstat(path).await?.attrs;
        if !(attrs.is_regular() || attrs.is_dir() || attrs.is_symlink()) {
            bail!("File actions do not support special device files.");
        }
        if revision.len() != 64 || entry_revision(&attrs) != revision {
            bail!("CONFLICT: The item changed since it was listed. Refresh the folder before trying again.");
        }
        Ok(attrs)
    }
}
#[async_trait]
impl FileMutationService for SftpTextFiles {
    async fn make_directory(&self, parent: &str, name: &str) -> Result<String> {
        let _lock = self.save_lock.lock().await;
        let path = self.child_path(parent, name).await?;
        self.require_absent(&path).await?;
        self.raw
            .mkdir(
                &path,
                FileAttributes {
                    permissions: Some(0o755),
                    ..FileAttributes::empty()
                },
            )
            .await
            .context("Folder creation was not confirmed. Check the directory before retrying")?;
        Ok(path)
    }
    async fn rename_entry(&self, path: &str, name: &str, revision: &str) -> Result<String> {
        let _lock = self.save_lock.lock().await;
        self.checked_entry(path, revision).await?;
        let (parent, _) = path.rsplit_once('/').context("Unsupported remote path")?;
        let destination = self
            .child_path(if parent.is_empty() { "/" } else { parent }, name)
            .await?;
        self.require_absent(&destination).await?;
        self.raw.rename(path, &destination).await.context("Rename was not confirmed. Refresh the directory before retrying; no overwrite was requested")?;
        Ok(destination)
    }
    async fn remove_entry(&self, path: &str, revision: &str) -> Result<()> {
        let _lock = self.save_lock.lock().await;
        let attrs = self.checked_entry(path, revision).await?;
        if attrs.is_dir() {
            self.raw.rmdir(path).await.context("Folder deletion was not confirmed. Only empty folders can be deleted; refresh before retrying")?;
        } else {
            // lstat + unlink removes the symlink, never its target. No recursion.
            self.raw
                .remove(path)
                .await
                .context("Deletion was not confirmed. Refresh the directory before retrying")?;
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_names_and_listing_preconditions() {
        for invalid in ["", " ", ".", "..", "a/b", "a\0b", "a\nb"] {
            assert!(validate_name(invalid).is_err());
        }
        assert!(validate_name("config 'quoted' $name 🌍.txt").is_ok());
        assert!(validate_name(&"é".repeat(128)).is_err());
        let mut attrs = FileAttributes {
            size: Some(4),
            mtime: Some(1),
            permissions: Some(0o100644),
            ..FileAttributes::empty()
        };
        let original = entry_revision(&attrs);
        attrs.atime = Some(99);
        assert_eq!(original, entry_revision(&attrs));
        attrs.size = Some(5);
        assert_ne!(original, entry_revision(&attrs));
    }
}
