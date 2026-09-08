// SPDX-License-Identifier: MPL-2.0
use crate::{
    text::validate_path, FileLocation, FileMoveService, FileMutationService, FileRelocation,
    RelocatedLocation, SftpTextFiles,
};
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
    pub(crate) async fn checked_entry(&self, path: &str, revision: &str) -> Result<FileAttributes> {
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
    async fn rename_tracked(
        &self,
        path: &str,
        name: &str,
        revision: &str,
        tracked: &[String],
    ) -> Result<FileRelocation> {
        let _lock = self.save_lock.lock().await;
        let attrs = self.checked_entry(path, revision).await?;
        let (parent, _) = path.rsplit_once('/').context("Unsupported remote path")?;
        let destination = self
            .child_path(if parent.is_empty() { "/" } else { parent }, name)
            .await?;
        self.require_absent(&destination).await?;
        let locations = relocated_locations(tracked, path, &destination, attrs.is_dir())?;
        self.raw.rename(path, &destination).await.context("Rename was not confirmed. Refresh the directory before retrying; no overwrite was requested")?;
        Ok(FileRelocation {
            path: destination,
            locations,
        })
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
#[async_trait]
impl FileMoveService for SftpTextFiles {
    async fn move_tracked(
        &self,
        path: &str,
        parent: &str,
        revision: &str,
        tracked: &[String],
    ) -> Result<FileRelocation> {
        let _lock = self.save_lock.lock().await;
        let attrs = self.checked_entry(path, revision).await?;
        let (_, name) = path.rsplit_once('/').context("Unsupported remote path")?;
        let destination = self.child_path(parent, name).await?;
        if destination == path {
            bail!("This item is already in the selected folder.");
        }
        // child_path resolves destination aliases before this ancestry check.
        if attrs.is_dir() && destination.starts_with(&format!("{path}/")) {
            bail!("A folder cannot be moved into itself or one of its children.");
        }
        self.require_absent(&destination).await?;
        let locations = relocated_locations(tracked, path, &destination, attrs.is_dir())?;
        // Standard v3 rename refuses replacement; never use posix-rename here or
        // silently fall back to copy/delete when filesystems differ.
        self.raw.rename(path, &destination).await.context(
            "Move was not confirmed. Inspect both folders before retrying; nothing was intentionally replaced. The server may prohibit moves between filesystems",
        )?;
        Ok(FileRelocation {
            path: destination,
            locations,
        })
    }
}
fn relocated_locations(
    tracked: &[String],
    source: &str,
    destination: &str,
    directory: bool,
) -> Result<Vec<RelocatedLocation>> {
    if tracked.len() > 256 {
        bail!("Too many tracked file locations (maximum 256)");
    }
    let mut result = Vec::new();
    for previous in tracked {
        validate_path(previous)?;
        // Tracked locations came from this provider. Noncanonical spelling does
        // not prove ancestry, and must never be redirected to another file.
        if !previous.starts_with('/') || previous.split('/').any(|s| matches!(s, "." | "..")) {
            continue;
        }
        let suffix = if previous == source {
            ""
        } else if directory {
            match previous.strip_prefix(&format!("{source}/")) {
                Some(suffix) => suffix,
                None => continue,
            }
        } else {
            continue;
        };
        let path = if suffix.is_empty() {
            destination.to_string()
        } else {
            format!("{destination}/{suffix}")
        };
        validate_path(&path)?;
        let (parent, name) = path
            .rsplit_once('/')
            .context("Unsupported destination path")?;
        result.push(RelocatedLocation {
            previous: previous.clone(),
            location: FileLocation {
                name: name.into(),
                parent: Some(if parent.is_empty() { "/" } else { parent }.into()),
                path,
            },
        });
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relocation_maps_exact_and_descendant_locations_without_following_links_or_sibling_prefixes()
    {
        let tracked = [
            "/root/tree",
            "/root/tree/a 🌍.txt",
            "/root/tree/sub/a",
            "/root/trees/a",
            "/elsewhere/a",
            "/root/tree/../secret",
        ]
        .map(String::from);
        let mapped = relocated_locations(&tracked, "/root/tree", "/dest/new", true).unwrap();
        assert_eq!(mapped.len(), 3);
        assert_eq!(mapped[0].location.name, "new");
        assert_eq!(mapped[0].location.parent.as_deref(), Some("/dest"));
        assert_eq!(mapped[1].location.path, "/dest/new/a 🌍.txt");
        assert_eq!(mapped[2].location.parent.as_deref(), Some("/dest/new/sub"));
        let exact = relocated_locations(&tracked, "/root/tree", "/renamed", false).unwrap();
        assert_eq!(exact.len(), 1); // Files and symlinks cannot relocate descendants.
        assert_eq!(exact[0].location.parent.as_deref(), Some("/"));
        assert!(relocated_locations(&vec!["/a".into(); 257], "/a", "/b", true).is_err());
    }
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
