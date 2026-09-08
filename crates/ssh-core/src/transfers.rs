// SPDX-License-Identifier: MPL-2.0
use crate::{
    entry_revision, provider::sftp_location, text::validate_path, FileLocation,
    FileTransferService, SftpTextFiles, TransferFile, TransferReader, TransferWriter,
    TRANSFER_CHUNK,
};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use russh_sftp::{
    client::error::Error as SftpError,
    protocol::{FileAttributes, OpenFlags, StatusCode},
};
use std::sync::Arc;

struct Reader {
    service: Arc<SftpTextFiles>,
    handle: Option<String>,
    file: TransferFile,
    revision: String,
    offset: u64,
}
#[async_trait]
impl TransferReader for Reader {
    fn file(&self) -> TransferFile {
        self.file.clone()
    }
    async fn read(&mut self) -> Result<Vec<u8>> {
        let handle = self.handle.as_ref().context("Download handle is closed")?;
        let data = match self
            .service
            .raw
            .read(handle, self.offset, TRANSFER_CHUNK as u32)
            .await
        {
            Ok(data) => data.data.to_vec(),
            Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => Vec::new(),
            Err(error) => return Err(error.into()),
        };
        if data.len() > TRANSFER_CHUNK || self.offset + data.len() as u64 > self.file.size {
            bail!("The remote file grew during download. Retry after it stops changing.");
        }
        self.offset += data.len() as u64;
        Ok(data)
    }
    async fn finish(&mut self) -> Result<()> {
        let handle = self.handle.as_ref().context("Download handle is closed")?;
        let current = self.service.raw.fstat(handle).await?.attrs;
        let path_current = self
            .service
            .raw
            .lstat(&self.file.location.path)
            .await?
            .attrs;
        if self.offset != self.file.size
            || entry_revision(&current) != self.revision
            || entry_revision(&path_current) != self.revision
        {
            bail!(
                "The remote file changed during download. The local destination was not published."
            );
        }
        self.abort().await
    }
    async fn abort(&mut self) -> Result<()> {
        if let Some(handle) = self.handle.take() {
            self.service.raw.close(handle).await?;
        }
        Ok(())
    }
}
struct Writer {
    service: Arc<SftpTextFiles>,
    handle: Option<String>,
    temporary: Option<String>,
    destination: String,
    size: u64,
    offset: u64,
}
// Normal completion/cancellation reports cleanup errors through finish/abort.
// Abandoned handles still get best-effort cleanup while the runtime is alive.
impl Drop for Reader {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                let service = self.service.clone();
                runtime.spawn(async move {
                    let _ = service.raw.close(handle).await;
                });
            }
        }
    }
}
impl Drop for Writer {
    fn drop(&mut self) {
        let handle = self.handle.take();
        let temporary = self.temporary.take();
        if handle.is_none() && temporary.is_none() {
            return;
        }
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let service = self.service.clone();
            runtime.spawn(async move {
                if let Some(handle) = handle {
                    let _ = service.raw.close(handle).await;
                }
                if let Some(path) = temporary {
                    let _ = service.raw.remove(path).await;
                }
            });
        }
    }
}
#[async_trait]
impl TransferWriter for Writer {
    async fn write(&mut self, bytes: &[u8]) -> Result<()> {
        if bytes.len() > TRANSFER_CHUNK || self.offset + bytes.len() as u64 > self.size {
            bail!("Upload exceeds its declared size or chunk limit");
        }
        self.service
            .raw
            .write(
                self.handle.as_ref().context("Upload handle is closed")?,
                self.offset,
                bytes.to_vec(),
            )
            .await?;
        self.offset += bytes.len() as u64;
        Ok(())
    }
    async fn finish(&mut self) -> Result<FileLocation> {
        if self.offset != self.size {
            bail!("The local file changed size during upload.");
        }
        if self.service.fsync {
            self.service
                .extension(
                    "fsync@openssh.com",
                    &[self.handle.as_ref().context("Upload handle is closed")?],
                )
                .await?;
        }
        if let Some(handle) = self.handle.take() {
            self.service.raw.close(handle).await?;
        }
        let _lock = self.service.save_lock.lock().await;
        self.service.require_absent(&self.destination).await?;
        self.service.raw.rename(self.temporary.as_ref().context("Upload already finished")?, &self.destination).await.context("Upload publication was not confirmed. Check the remote destination before retrying; it may already exist")?;
        self.temporary = None;
        Ok(sftp_location(self.destination.clone()))
    }
    async fn abort(&mut self) -> Result<()> {
        let mut errors = Vec::new();
        if let Some(handle) = self.handle.take() {
            if let Err(error) = self.service.raw.close(handle).await {
                errors.push(format!("Close failed: {error}"));
            }
        }
        if let Some(path) = self.temporary.take() {
            if let Err(error) = self.service.raw.remove(&path).await {
                if !matches!(&error, SftpError::Status(s) if s.status_code == StatusCode::NoSuchFile)
                {
                    errors.push(format!("Temporary upload cleanup failed: {path}. {error}"));
                }
            }
        }
        if !errors.is_empty() {
            bail!("{}", errors.join("; "));
        }
        Ok(())
    }
}

#[async_trait]
impl FileTransferService for SftpTextFiles {
    fn supports_folders(&self) -> bool {
        true
    }
    async fn transfer_children(
        &self,
        path: &str,
        revision: &str,
        limit: usize,
    ) -> Result<Vec<crate::FileEntry>> {
        if !self.checked_entry(path, revision).await?.is_dir() {
            bail!("Folder transfers do not follow symbolic links");
        }
        let handle = self.raw.opendir(path).await?.handle;
        let work = async {
            let mut entries = Vec::new();
            loop {
                let batch = match self.raw.readdir(&handle).await {
                    Ok(batch) => batch.files,
                    Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => break,
                    Err(error) => return Err(error.into()),
                };
                if batch.is_empty() { bail!("The server returned an empty directory page without EOF"); }
                for item in batch {
                    if matches!(item.filename.as_str(), "." | "..") { continue; }
                    crate::file_actions::validate_name(&item.filename)?;
                    if entries.len() >= limit { bail!("Folder transfer exceeds the entry limit"); }
                    if !item.attrs.is_regular() && !item.attrs.is_dir() {
                        bail!("Folder contains a link or special file: {}. These are not followed or copied.", item.filename);
                    }
                    entries.push(crate::FileEntry {
                        path: format!("{}/{}", path.trim_end_matches('/'), item.filename),
                        name: item.filename,
                        kind: if item.attrs.is_dir() { "directory" } else { "file" }.into(),
                        size: if item.attrs.is_dir() { 0 } else { item.attrs.size.context("Missing file size")? },
                        modified: item.attrs.mtime,
                        revision: entry_revision(&item.attrs),
                    });
                }
            }
            self.checked_entry(path, revision).await?;
            Ok(entries)
        }.await;
        let closed = self.raw.close(handle).await;
        let entries = work?;
        closed?;
        Ok(entries)
    }
    async fn transfer_mkdir(&self, parent: &str, name: &str) -> Result<FileLocation> {
        let path = crate::FileMutationService::make_directory(self, parent, name).await?;
        Ok(sftp_location(path))
    }
    async fn download(
        self: Arc<Self>,
        path: &str,
        revision: &str,
    ) -> Result<Box<dyn TransferReader>> {
        validate_path(path)?;
        // Refuse links and special files. The selected listing supplies a precondition.
        let metadata = self.raw.lstat(path).await?.attrs;
        if !metadata.is_regular() {
            bail!("Download supports regular files only.");
        }
        if revision.len() != 64 || entry_revision(&metadata) != revision {
            bail!("The remote item changed. Refresh its folder before downloading.");
        }
        let handle = self
            .raw
            .open(path, OpenFlags::READ, FileAttributes::empty())
            .await?
            .handle;
        let checked: Result<FileAttributes> = async {
            let current = self.raw.fstat(&handle).await?.attrs;
            if !current.is_regular() || entry_revision(&current) != revision {
                bail!("The remote file changed while opening it.");
            }
            current
                .size
                .context("The server did not report a file size")?;
            Ok(current)
        }
        .await;
        let current = match checked {
            Ok(metadata) => metadata,
            Err(error) => {
                let _ = self.raw.close(handle).await;
                return Err(error);
            }
        };
        Ok(Box::new(Reader {
            service: self,
            handle: Some(handle),
            file: TransferFile {
                location: sftp_location(path.into()),
                size: current.size.unwrap(),
            },
            revision: revision.into(),
            offset: 0,
        }))
    }
    async fn upload(
        self: Arc<Self>,
        parent: &str,
        name: &str,
        size: u64,
    ) -> Result<Box<dyn TransferWriter>> {
        let destination = self.child_path(parent, name).await?;
        self.require_absent(&destination).await?;
        let canonical_parent = sftp_location(destination.clone())
            .parent
            .context("Upload destination has no parent")?;
        let temporary = self
            .child_path(
                &canonical_parent,
                &format!(".shellcanvas-upload-{}", uuid::Uuid::new_v4()),
            )
            .await?;
        let handle = self.raw.open(&temporary, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
            FileAttributes { permissions: Some(0o600), ..FileAttributes::empty() }).await
            .with_context(|| format!("Temporary upload creation was not confirmed. Check {temporary} before retrying"))?.handle;
        Ok(Box::new(Writer {
            service: self,
            handle: Some(handle),
            temporary: Some(temporary),
            destination,
            size,
            offset: 0,
        }))
    }
}
