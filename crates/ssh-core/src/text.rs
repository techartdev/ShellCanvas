// SPDX-License-Identifier: MPL-2.0
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use russh_sftp::{
    client::{error::Error as SftpError, RawSftpSession},
    protocol::{FileAttributes, OpenFlags, Packet, StatusCode},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

pub const TEXT_LIMIT: usize = 256 * 1024;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDocument {
    pub path: String,
    pub text: String,
    pub revision: String,
    pub writable: bool,
}
pub fn text_revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn document_revision(text: &str, metadata: &FileAttributes) -> String {
    let mut hash = Sha256::new();
    hash.update(text.as_bytes());
    hash.update(format!(
        "\0{:?}:{:?}:{:?}",
        metadata.uid, metadata.gid, metadata.permissions
    ));
    format!("{:x}", hash.finalize())
}
pub(crate) fn validate_text(text: &str) -> Result<()> {
    if text.len() > TEXT_LIMIT {
        bail!("Text editing is limited to 256 KiB.");
    }
    if text.contains('\0') {
        bail!("Binary content cannot be saved by the text editor.");
    }
    Ok(())
}
pub(crate) fn validate_path(path: &str) -> Result<()> {
    if path.is_empty() || path.len() > 4096 || path.contains(['\0', '\r', '\n']) {
        bail!("Invalid file path.");
    }
    Ok(())
}
fn check_revision(actual: &str, expected: &str) -> Result<()> {
    if expected.len() != 64 || actual != expected {
        bail!("CONFLICT: The remote file changed. Your draft is intact. Reload the remote version or copy your draft before trying again.");
    }
    Ok(())
}
#[async_trait]
pub trait TextFileService: Send + Sync {
    async fn read_text(&self, path: &str) -> Result<TextDocument>;
    async fn create_text(&self, parent: &str, name: &str, text: &str) -> Result<TextDocument>;
    async fn save_text(
        &self,
        path: &str,
        text: &str,
        expected_revision: &str,
    ) -> Result<TextDocument>;
}

/// Dedicated SFTP channel; saves in this workspace serialize across editor windows.
pub struct SftpTextFiles {
    pub(crate) raw: RawSftpSession,
    atomic_replace: bool,
    fsync: bool,
    pub(crate) save_lock: Mutex<()>,
}
impl SftpTextFiles {
    pub async fn new(raw: RawSftpSession) -> Result<Self> {
        let version = raw.init().await?;
        Ok(Self {
            atomic_replace: version
                .extensions
                .get("posix-rename@openssh.com")
                .is_some_and(|v| v == "1"),
            fsync: version
                .extensions
                .get("fsync@openssh.com")
                .is_some_and(|v| v == "1"),
            raw,
            save_lock: Mutex::new(()),
        })
    }
    pub fn can_save(&self) -> bool {
        self.atomic_replace
    }
    async fn snapshot(&self, path: &str) -> Result<(TextDocument, FileAttributes)> {
        validate_path(path)?;
        let path = self
            .raw
            .realpath(path)
            .await?
            .files
            .into_iter()
            .next()
            .context("Server did not resolve the file path")?
            .filename;
        let before = self.raw.stat(&path).await?.attrs;
        if !before.is_regular() || before.size.is_some_and(|s| s > TEXT_LIMIT as u64) {
            bail!("Open a regular UTF-8 text file no larger than 256 KiB.");
        }
        let handle = self
            .raw
            .open(&path, OpenFlags::READ, FileAttributes::empty())
            .await?
            .handle;
        let result: Result<(String, FileAttributes)> = async {
            let metadata = self.raw.fstat(&handle).await?.attrs;
            if !metadata.is_regular() {
                bail!("Text editing supports regular files only.");
            }
            let mut bytes = Vec::new();
            loop {
                match self.raw.read(&handle, bytes.len() as u64, 32768).await {
                    Ok(data) => {
                        if data.data.is_empty() {
                            break;
                        }
                        bytes.extend_from_slice(&data.data);
                        if bytes.len() > TEXT_LIMIT {
                            bail!("Text editing is limited to 256 KiB.");
                        }
                    }
                    Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => {
                        break
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            let text = String::from_utf8(bytes).context("This file is not UTF-8 text.")?;
            validate_text(&text)?;
            Ok((text, metadata))
        }
        .await;
        let close = self.raw.close(handle).await;
        let (text, metadata) = result?;
        close?;
        Ok((
            TextDocument {
                path,
                revision: document_revision(&text, &metadata),
                text,
                writable: self.can_save(),
            },
            metadata,
        ))
    }
    async fn extension(&self, name: &str, strings: &[&str]) -> Result<()> {
        let mut data = Vec::new();
        for value in strings {
            data.extend_from_slice(&(value.len() as u32).to_be_bytes());
            data.extend_from_slice(value.as_bytes());
        }
        match self.raw.extended(name, data).await? {
            Packet::Status(status) if status.status_code == StatusCode::Ok => Ok(()),
            Packet::Status(status) => bail!("{}: {}", status.status_code, status.error_message),
            _ => bail!("Unexpected response to {name}"),
        }
    }
}
#[async_trait]
impl TextFileService for SftpTextFiles {
    async fn create_text(&self, parent: &str, name: &str, text: &str) -> Result<TextDocument> {
        validate_text(text)?;
        let _lock = self.save_lock.lock().await;
        let path = self.child_path(parent, name).await?;
        self.require_absent(&path).await?;
        let parent = path.rsplit_once('/').context("Unsupported remote path")?.0;
        let temporary = self
            .child_path(
                if parent.is_empty() { "/" } else { parent },
                &format!(".shellcanvas-save-{}", uuid::Uuid::new_v4()),
            )
            .await?;
        let handle = self
            .raw
            .open(
                &temporary,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                FileAttributes {
                    permissions: Some(0o600),
                    ..FileAttributes::empty()
                },
            )
            .await
            .with_context(|| {
                format!(
                    "Temporary file creation was not confirmed. Check {temporary} before retrying"
                )
            })?
            .handle;
        let write: Result<()> = async {
            for (index, chunk) in text.as_bytes().chunks(32768).enumerate() {
                self.raw
                    .write(&handle, (index * 32768) as u64, chunk.to_vec())
                    .await?;
            }
            if self.fsync {
                self.extension("fsync@openssh.com", &[&handle]).await?;
            }
            Ok(())
        }
        .await;
        let closed = self.raw.close(handle).await;
        let commit: Result<()> = async {
            write?; closed?;
            self.require_absent(&path).await?;
            // SFTP v3 RENAME refuses an existing target, unlike posix-rename.
            self.raw.rename(&temporary, &path).await.context("Create confirmation failed; the remote outcome may be uncertain. Keep your draft and check the destination before retrying")?;
            Ok(())
        }.await;
        if let Err(error) = commit {
            if let Err(cleanup) = self.raw.remove(&temporary).await {
                if !matches!(&cleanup, SftpError::Status(s) if s.status_code == StatusCode::NoSuchFile)
                {
                    return Err(error.context(format!(
                        "Temporary save cleanup failed: {temporary}. {cleanup}"
                    )));
                }
            }
            return Err(error);
        }
        let saved = self
            .snapshot(&path)
            .await
            .context("File created but readback failed. Keep your draft and check the destination")?
            .0;
        if saved.text != text {
            bail!("CONFLICT: The new file changed after creation. Keep your draft.");
        }
        Ok(saved)
    }
    async fn read_text(&self, path: &str) -> Result<TextDocument> {
        Ok(self.snapshot(path).await?.0)
    }
    async fn save_text(
        &self,
        path: &str,
        text: &str,
        expected_revision: &str,
    ) -> Result<TextDocument> {
        validate_path(path)?;
        validate_text(text)?;
        if !self.can_save() {
            bail!(
                "This SFTP server does not support atomic file replacement. Saving is unavailable."
            );
        }
        let _lock = self.save_lock.lock().await;
        let (original, metadata) = self.snapshot(path).await?;
        check_revision(&original.revision, expected_revision)?;
        // Commit to the resolved path the editor displays, never replace a symlink itself.
        if original.path != path {
            bail!("The file path changed. Reopen its resolved path before saving.");
        }
        let parent = original
            .path
            .rsplit_once('/')
            .context("Unsupported remote path")?
            .0;
        let temporary = format!("{parent}/.shellcanvas-save-{}", uuid::Uuid::new_v4());
        let handle = self
            .raw
            .open(
                &temporary,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                FileAttributes {
                    permissions: Some(0o600),
                    ..FileAttributes::empty()
                },
            )
            .await?
            .handle;
        let write: Result<()> = async {
            for (index, chunk) in text.as_bytes().chunks(32768).enumerate() {
                self.raw
                    .write(&handle, (index * 32768) as u64, chunk.to_vec())
                    .await?;
            }
            self.raw
                .fsetstat(
                    &handle,
                    FileAttributes {
                        uid: metadata.uid,
                        gid: metadata.gid,
                        permissions: metadata.permissions,
                        ..FileAttributes::empty()
                    },
                )
                .await
                .context("Cannot preserve the original file owner and permissions")?;
            if self.fsync {
                self.extension("fsync@openssh.com", &[&handle]).await?;
            }
            Ok(())
        }
        .await;
        let closed = self.raw.close(handle).await;
        let commit: Result<()> = async {
            write?;
            closed?;
            let current = self.snapshot(path).await?.0;
            if current.path != original.path { bail!("CONFLICT: The remote file path changed."); }
            check_revision(&current.revision, expected_revision)?;
            self.extension("posix-rename@openssh.com", &[&temporary, path]).await.context("Save confirmation failed; remote outcome may be uncertain. Keep your draft and reload before retrying")?;
            Ok(())
        }.await;
        if let Err(error) = commit {
            let cleanup = self.raw.remove(&temporary).await;
            if let Err(cleanup_error) = cleanup {
                if !matches!(&cleanup_error, SftpError::Status(s) if s.status_code == StatusCode::NoSuchFile)
                {
                    return Err(error.context(format!(
                        "Temporary save cleanup failed: {temporary}. {cleanup_error}"
                    )));
                }
            }
            return Err(error);
        }
        let saved = self.snapshot(path).await.context("Save completed but could not be read back; keep your draft and reload before retrying")?.0;
        if saved.text != text {
            bail!("CONFLICT: The file changed again after saving. Your draft is still available.");
        }
        Ok(saved)
    }
}
impl Drop for SftpTextFiles {
    fn drop(&mut self) {
        let _ = self.raw.close_session();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_binary_oversized_and_changed_content() {
        assert!(validate_text("hello\0world").is_err());
        assert!(validate_text(&"x".repeat(TEXT_LIMIT + 1)).is_err());
        assert!(validate_text("hello 🌍\r\n").is_ok());
        assert!(check_revision(&text_revision(b"new"), &text_revision(b"old")).is_err());
        assert!(check_revision(&text_revision(b"same"), &text_revision(b"same")).is_ok());
        assert!(validate_path("/tmp/file\nother").is_err());
        let original = FileAttributes {
            permissions: Some(0o100644),
            ..FileAttributes::empty()
        };
        let changed = FileAttributes {
            permissions: Some(0o100600),
            ..FileAttributes::empty()
        };
        assert_ne!(
            document_revision("same", &original),
            document_revision("same", &changed)
        );
    }
}
