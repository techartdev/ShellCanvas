// SPDX-License-Identifier: MPL-2.0
use crate::{TextDocument, TextFileService};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use russh_sftp::{
    client::{error::Error as SftpError, RawSftpSession},
    protocol::{FileAttributes, OpenFlags, Packet, StatusCode},
};
use sha2::{Digest, Sha256};
use std::sync::{atomic::AtomicBool, Arc};
use tokio::sync::Mutex;

pub const TEXT_LIMIT: usize = 256 * 1024;
// Keep SFTP WRITE payloads below the SSH channel packet boundary, including
// framing. Windows OpenSSH can stall larger requests on the current transport.
pub(crate) const SFTP_WRITE_CHUNK: usize = 16 * 1024;
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
/// Dedicated SFTP channel; saves in this workspace serialize across editor windows.
pub struct SftpTextFiles {
    pub(crate) raw: RawSftpSession,
    atomic_replace: bool,
    pub(crate) windows: bool,
    pub(crate) fsync: bool,
    pub(crate) save_lock: Mutex<()>,
    pub(crate) channel_closed: Arc<AtomicBool>,
}
impl SftpTextFiles {
    pub(crate) async fn from_stream<S>(stream: S) -> Result<Self>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let closed = Arc::new(AtomicBool::new(false));
        let raw = RawSftpSession::new(crate::sftp_transport::Observed::new(stream, closed.clone()));
        let mut service = Self::new(raw).await?;
        service.channel_closed = closed;
        Ok(service)
    }
    /// Wrap an externally managed raw session. Its owner supplies connection
    /// lifetime; desktop connections use `from_stream` to observe idle EOF too.
    pub async fn new(raw: RawSftpSession) -> Result<Self> {
        let version = raw.init().await?;
        Ok(Self {
            windows: false,
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
            channel_closed: Arc::new(AtomicBool::new(false)),
        })
    }
    pub fn can_save(&self) -> bool {
        self.atomic_replace && !self.windows
    }
    /// Configure semantics using identification from this same SSH connection.
    pub fn with_identified_provider(mut self, provider: &str) -> Self {
        self.windows = provider == "windows";
        self
    }
    pub(crate) fn can_replace_atomically(&self) -> bool {
        self.atomic_replace
    }
    pub(crate) async fn write_chunks(
        &self,
        handle: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<(), SftpError> {
        for (index, chunk) in bytes.chunks(SFTP_WRITE_CHUNK).enumerate() {
            self.raw
                .write(
                    handle,
                    offset + (index * SFTP_WRITE_CHUNK) as u64,
                    chunk.to_vec(),
                )
                .await?;
        }
        Ok(())
    }
    async fn read_handle(&self, handle: &str) -> Result<(String, FileAttributes)> {
        let metadata = self.raw.fstat(handle).await?.attrs;
        if !crate::transfers::regular_file(&metadata) {
            bail!("Text editing supports regular files only.");
        }
        let mut bytes = Vec::new();
        loop {
            match self.raw.read(handle, bytes.len() as u64, 32768).await {
                Ok(data) => {
                    if data.data.is_empty() {
                        break;
                    }
                    bytes.extend_from_slice(&data.data);
                    if bytes.len() > TEXT_LIMIT {
                        bail!("Text editing is limited to 256 KiB.");
                    }
                }
                Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => break,
                Err(error) => return Err(error.into()),
            }
        }
        let text = String::from_utf8(bytes).context("This file is not UTF-8 text.")?;
        validate_text(&text)?;
        Ok((text, metadata))
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
        if !crate::transfers::regular_file(&before)
            || before.size.is_some_and(|s| s > TEXT_LIMIT as u64)
        {
            bail!("Open a regular UTF-8 text file no larger than 256 KiB.");
        }
        let handle = self
            .raw
            .open(&path, OpenFlags::READ, FileAttributes::empty())
            .await?
            .handle;
        let result = self.read_handle(&handle).await;
        let close = self.raw.close(handle).await;
        let (text, mut metadata) = result?;
        close?;
        if self.windows {
            // Windows FSTAT synthesizes mode bits. Use path metadata for the
            // editor revision while retaining the open-handle consistency check.
            let after = self.raw.stat(&path).await?.attrs;
            if !crate::transfers::opened_metadata_matches(&before, &metadata, true)
                || crate::entry_revision(&before) != crate::entry_revision(&after)
            {
                bail!("CONFLICT: The remote file changed while reading it.");
            }
            metadata = after;
        }
        let location = crate::provider::sftp_location(path);
        Ok((
            TextDocument {
                name: location.name,
                parent: location.parent,
                path: location.path,
                revision: document_revision(&text, &metadata),
                text,
                writable: true,
                save_requires_confirmation: !self.can_save(),
            },
            metadata,
        ))
    }
    pub(crate) async fn extension(&self, name: &str, strings: &[&str]) -> Result<()> {
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
    async fn save_text_confirmed(
        &self,
        path: &str,
        text: &str,
        revision: &str,
        allow_non_atomic: bool,
    ) -> Result<TextDocument> {
        if self.can_save() || !allow_non_atomic {
            return self.save_text(path, text, revision).await;
        }
        validate_path(path)?;
        validate_text(text)?;
        let _lock = self.save_lock.lock().await;
        let (original, original_metadata) = self.snapshot(path).await?;
        check_revision(&original.revision, revision)?;
        if original.path != path {
            bail!("The file path changed. Reopen its resolved path before saving.");
        }
        // Never create or truncate on open. A denied open leaves the original intact.
        // In-place writes preserve owner/permissions but are deliberately non-atomic.
        let handle = self
            .raw
            .open(
                path,
                if self.windows {
                    OpenFlags::READ | OpenFlags::WRITE
                } else {
                    OpenFlags::WRITE
                },
                FileAttributes::empty(),
            )
            .await?
            .handle;
        let write: Result<()> = async {
            if self.windows {
                // Windows may deny a second open while a writable handle exists.
                // Recheck contents through the exact handle we will write to.
                let (current_text, handle_metadata) = self
                    .read_handle(&handle)
                    .await
                    .context("Reading the writable file handle")?;
                let path_metadata = self
                    .raw
                    .lstat(path)
                    .await
                    .context("Rechecking the writable file path")?
                    .attrs;
                if !crate::transfers::opened_metadata_matches(
                    &path_metadata,
                    &handle_metadata,
                    true,
                ) || crate::entry_revision(&path_metadata)
                    != crate::entry_revision(&original_metadata)
                {
                    bail!("CONFLICT: The remote file changed while opening for saving.");
                }
                check_revision(&document_revision(&current_text, &path_metadata), revision)?;
            } else {
                let current = self
                    .snapshot(path)
                    .await
                    .context("Rechecking the file after opening for writing")?
                    .0;
                if current.path != path {
                    bail!("CONFLICT: The remote file path changed.");
                }
                check_revision(&current.revision, revision)?;
            }
            self.write_chunks(&handle, 0, text.as_bytes())
                .await
                .context("Writing existing file contents")?;
            self.raw
                .fsetstat(
                    &handle,
                    FileAttributes {
                        size: Some(text.len() as u64),
                        ..FileAttributes::empty()
                    },
                )
                .await
                .context("Setting saved file length")?;
            if self.fsync {
                self.extension("fsync@openssh.com", &[&handle]).await?;
            }
            Ok(())
        }
        .await;
        let closed = self.raw.close(handle).await;
        write.and(closed.map(|_| ()).map_err(Into::into))
            .context("Non-atomic save did not complete. The remote file may contain partial changes. Your draft is intact; reload or inspect the remote file before retrying")?;
        let saved = self.snapshot(path).await.context("Save finished but readback failed. Keep your draft and inspect the remote file before retrying")?.0;
        if saved.text != text {
            bail!("CONFLICT: The file changed after saving. Your draft is intact.");
        }
        Ok(saved)
    }
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
            self.write_chunks(&handle, 0, text.as_bytes()).await?;
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
                "Atomic saving with permission preservation is unavailable on this server. Confirm a non-atomic save in the editor or use Save As with a new name."
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
            self.write_chunks(&handle, 0, text.as_bytes()).await?;
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
