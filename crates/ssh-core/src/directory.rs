// SPDX-License-Identifier: MPL-2.0
use crate::{provider::sftp_location, SftpTextFiles, OP_TIMEOUT};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use russh_sftp::{
    client::error::Error as SftpError,
    protocol::{File, StatusCode},
};
use shellcanvas_services::*;
use std::{collections::VecDeque, sync::Arc};

/// Shares the established raw SFTP channel with other file services. Browsing
/// requires no write extensions, remote executable or whole-directory buffer.
pub struct SftpBrowser(pub Arc<SftpTextFiles>);
impl SftpBrowser {
    pub async fn canonicalize(&self, path: &str) -> Result<String> {
        tokio::time::timeout(OP_TIMEOUT, self.0.raw.realpath(path))
            .await?
            .context("Cannot resolve directory")?
            .files
            .into_iter()
            .next()
            .map(|file| file.filename)
            .filter(|path| !path.is_empty())
            .context("Server did not resolve the directory")
    }
    async fn open(&self, path: Option<&str>) -> Result<Box<dyn DirectoryReader>> {
        let path = self.canonicalize(path.unwrap_or(".")).await?;
        let location = sftp_location(path.clone());
        let home = self.canonicalize(".").await.ok().map(|path| FilePlace {
            path,
            name: "Home".into(),
        });
        let roots = self
            .canonicalize("/")
            .await
            .ok()
            .map(|path| FilePlace {
                path,
                name: "Filesystem".into(),
            })
            .into_iter()
            .collect();
        let service = self.0.clone();
        // The spawned operation owns late successful opens. If the caller is
        // canceled, its returned guard is dropped and closes that handle.
        let handle = tokio::spawn(async move {
            let id = service.raw.opendir(&path).await?.handle;
            Ok::<_, anyhow::Error>(DirectoryHandle {
                service,
                id: Some(id),
                outcome: None,
            })
        })
        .await??;
        Ok(Box::new(SftpDirectory {
            handle,
            metadata: Directory {
                path: location.path,
                name: location.name,
                parent: location.parent,
                home,
                roots,
                entries: vec![],
            },
            pending: VecDeque::new(),
            active: true,
            eof: false,
        }))
    }
}
#[async_trait]
impl FileSystemProvider for SftpBrowser {
    async fn list(&self, path: Option<&str>) -> Result<Directory> {
        let mut directory = collect_directory(self.open(path).await?).await?;
        // Existing materializing callers retain their presentation order. Page
        // consumers receive server order and may sort the entries they display.
        directory.entries.sort_by(|a, b| {
            (a.kind != "directory", a.name.to_lowercase())
                .cmp(&(b.kind != "directory", b.name.to_lowercase()))
        });
        Ok(directory)
    }
    async fn open_directory(
        self: Arc<Self>,
        path: Option<&str>,
    ) -> Result<Box<dyn DirectoryReader>> {
        self.open(path).await
    }
    async fn locate(&self, path: &str) -> Result<FileLocation> {
        Ok(sftp_location(self.canonicalize(path).await?))
    }
    async fn preview(&self, path: &str) -> Result<String> {
        Ok(self.0.read_text(path).await?.text)
    }
}
struct DirectoryHandle {
    service: Arc<SftpTextFiles>,
    id: Option<String>,
    outcome: Option<tokio::sync::watch::Receiver<Option<std::result::Result<(), String>>>>,
}
impl DirectoryHandle {
    async fn close(&mut self) -> Result<()> {
        if let Some(id) = self.id.take() {
            let service = self.service.clone();
            let (completed, outcome) = tokio::sync::watch::channel(None);
            self.outcome = Some(outcome);
            // Closing continues if its waiter is dropped. Never retry a handle
            // identity which the server may already have released/reused.
            tokio::spawn(async move {
                let result =
                    service.raw.close(id).await.map(|_| ()).map_err(|error| {
                        format!("Directory cleanup could not be confirmed: {error}")
                    });
                completed.send_replace(Some(result));
            });
        }
        let outcome = self
            .outcome
            .as_mut()
            .context("Directory cleanup was not started")?;
        loop {
            if let Some(result) = outcome.borrow_and_update().clone() {
                return result.map_err(anyhow::Error::msg);
            }
            outcome
                .changed()
                .await
                .context("Directory cleanup could not be confirmed")?;
        }
    }
}
impl Drop for DirectoryHandle {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            let service = self.service.clone();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = service.raw.close(id).await;
                });
            }
        }
    }
}
struct SftpDirectory {
    handle: DirectoryHandle,
    metadata: Directory,
    pending: VecDeque<File>,
    active: bool,
    eof: bool,
}
impl SftpDirectory {
    async fn page(&mut self) -> Result<DirectoryPage> {
        let mut directory = self.metadata.clone();
        while directory.entries.len() < DIRECTORY_PAGE {
            if let Some(file) = self.pending.pop_front() {
                if matches!(file.filename.as_str(), "." | "..") {
                    continue;
                }
                if file.filename.is_empty() || file.filename.contains(['/', '\0']) {
                    bail!("Invalid SFTP directory entry name");
                }
                directory.entries.push(FileEntry {
                    path: format!("{}/{}", directory.path.trim_end_matches('/'), file.filename),
                    name: file.filename,
                    kind: if file.attrs.is_dir() {
                        "directory"
                    } else if file.attrs.is_symlink() {
                        "symlink"
                    } else {
                        "file"
                    }
                    .into(),
                    size: file.attrs.size.unwrap_or(0),
                    modified: file.attrs.mtime,
                    revision: crate::entry_revision(&file.attrs),
                });
            } else if self.eof {
                break;
            } else {
                match self
                    .handle
                    .service
                    .raw
                    .readdir(
                        self.handle
                            .id
                            .as_ref()
                            .context("Directory reader is closed")?,
                    )
                    .await
                {
                    Ok(batch) => {
                        if batch.files.is_empty() {
                            bail!("Server returned an empty directory page without EOF");
                        }
                        self.pending = batch.files.into();
                    }
                    Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => {
                        self.eof = true
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        }
        Ok(DirectoryPage {
            directory,
            done: self.eof && self.pending.is_empty(),
        })
    }
}
#[async_trait]
impl DirectoryReader for SftpDirectory {
    async fn next(&mut self) -> Result<DirectoryPage> {
        if !self.active {
            bail!("Directory reader is closed");
        }
        self.active = false;
        let result = tokio::time::timeout(OP_TIMEOUT, self.page())
            .await
            .context("Directory page timed out")
            .and_then(|result| result);
        match result {
            Ok(page) => {
                if page.done {
                    self.handle.close().await?;
                } else {
                    self.active = true;
                }
                Ok(page)
            }
            Err(error) => {
                let _ = self.close().await;
                Err(error)
            }
        }
    }
    async fn close(&mut self) -> Result<()> {
        self.active = false;
        self.pending.clear();
        self.handle.close().await
    }
}
