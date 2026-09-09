// SPDX-License-Identifier: MPL-2.0
//! Bounded streams over an installed adapter; no file or tree is materialized here.
use crate::AdapterProcess;
use anyhow::{anyhow, bail, Result};
use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use shellcanvas_services::*;
use std::{sync::Arc, time::Duration};
use tokio::sync::OwnedSemaphorePermit;

const DOWNLOAD: &[&str] = &[
    "files.download.open",
    "files.download.read",
    "files.download.finish",
    "files.transfer.abort",
];
const UPLOAD: &[&str] = &[
    "files.upload.open",
    "files.upload.write",
    "files.upload.finish",
    "files.transfer.abort",
];
const FOLDERS: &[&str] = &[
    "files.transfer.entry",
    "files.directory.open",
    "files.directory.next",
    "files.directory.finish",
    "files.transfer.mkdir",
    "files.transfer.abort",
];

impl AdapterProcess {
    pub fn downloads_supported(&self) -> bool {
        self.supports("files", 1, DOWNLOAD)
    }
    pub fn uploads_supported(&self) -> bool {
        self.supports("files", 1, UPLOAD)
    }
    pub fn transfers(&self) -> Option<Arc<dyn FileTransferService>> {
        (self.downloads_supported() || self.uploads_supported())
            .then(|| Arc::new(Transfers(self.clone())) as Arc<dyn FileTransferService>)
    }
}
struct Transfers(AdapterProcess);

async fn call<T: DeserializeOwned>(
    adapter: &AdapterProcess,
    method: &str,
    params: Value,
    write: bool,
) -> Result<T> {
    let value = adapter.call(method, params, Duration::from_secs(30)).await.map_err(|error| {
        if write && error.outcome_uncertain {
            anyhow!("{}. The transfer may have changed the destination; inspect it before retrying.", error.message)
        } else { error.into() }
    })?;
    serde_json::from_value(value).map_err(|error| {
        anyhow!(
            "Invalid {method} response: {error}{}",
            if write {
                ". The transfer may have changed the destination; inspect it before retrying."
            } else {
                ""
            }
        )
    })
}
fn location(location: FileLocation, write: bool) -> Result<FileLocation> {
    if location.path.is_empty() {
        bail!(
            "Adapter returned an empty transfer location{}",
            if write {
                ". The destination may have been published; inspect it before retrying."
            } else {
                ""
            }
        );
    }
    Ok(location)
}

struct Handle {
    adapter: AdapterProcess,
    id: String,
    permit: Option<OwnedSemaphorePermit>,
    ready: bool,
}
impl Handle {
    fn new(adapter: AdapterProcess) -> Result<Self> {
        let permit = adapter
            .transfer_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| anyhow!("Adapter transfer capacity is exhausted; finish active transfers or reconnect if cleanup failed"))?;
        Ok(Self {
            adapter,
            id: uuid::Uuid::new_v4().to_string(),
            permit: Some(permit),
            ready: false,
        })
    }
    fn begin(&mut self) -> Result<()> {
        if !self.ready || self.permit.is_none() || !self.adapter.connected() {
            bail!("This transfer is closed or its last operation did not complete; abort it before retrying");
        }
        // A dropped future cannot leave a cursor usable at an unknown remote offset.
        self.ready = false;
        Ok(())
    }
    fn complete(&mut self) {
        self.ready = false;
        self.permit.take();
    }
    async fn abort(&mut self) -> Result<()> {
        self.ready = false;
        if self.permit.is_none() {
            return Ok(());
        }
        cleanup(&self.adapter, &self.id).await?;
        self.complete();
        Ok(())
    }
}
async fn cleanup(adapter: &AdapterProcess, id: &str) -> Result<()> {
    let result = adapter
        .call(
            "files.transfer.abort",
            json!({"id":id}),
            Duration::from_secs(3),
        )
        .await?;
    serde_json::from_value::<()>(result)
        .map_err(|error| anyhow!("Unconfirmed adapter transfer cleanup: {error}"))
}
impl Drop for Handle {
    fn drop(&mut self) {
        let Some(permit) = self.permit.take() else {
            return;
        };
        let adapter = self.adapter.clone();
        let id = self.id.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                if cleanup(&adapter, &id).await.is_err() {
                    // Unknown remote resources continue to count against this process's budget.
                    permit.forget();
                }
            });
        } else {
            permit.forget();
        }
    }
}
struct Reader {
    handle: Handle,
    file: TransferFile,
    offset: u64,
}
struct Writer {
    handle: Handle,
    size: u64,
    offset: u64,
}
struct DirectoryReader {
    handle: Handle,
    eof: bool,
}

#[async_trait]
impl FileTransferService for Transfers {
    fn supports_folders(&self) -> bool {
        self.0.supports("files", 1, FOLDERS)
    }
    async fn transfer_entry(self: Arc<Self>, path: &str, revision: &str) -> Result<FileEntry> {
        if self.0.supports("files", 1, &["files.transfer.entry"]) {
            let entry: FileEntry = call(
                &self.0,
                "files.transfer.entry",
                json!({"path":path,"revision":revision}),
                false,
            )
            .await?;
            if entry.path.is_empty() || entry.revision.is_empty() {
                bail!("Adapter returned an invalid transfer entry");
            }
            return Ok(entry);
        }
        let mut reader = self.download(path, revision).await?;
        let file = reader.file();
        reader.abort().await?;
        Ok(FileEntry {
            path: file.location.path,
            name: file.location.name,
            kind: "file".into(),
            size: file.size,
            modified: None,
            revision: revision.into(),
        })
    }
    async fn download(
        self: Arc<Self>,
        path: &str,
        revision: &str,
    ) -> Result<Box<dyn TransferReader>> {
        if !self.0.downloads_supported() {
            bail!("Downloads are unavailable through this adapter");
        }
        let mut handle = Handle::new(self.0.clone())?;
        let file: TransferFile = call(
            &self.0,
            "files.download.open",
            json!({"id":handle.id,"path":path,"revision":revision}),
            false,
        )
        .await?;
        location(file.location.clone(), false)?;
        handle.ready = true;
        Ok(Box::new(Reader {
            handle,
            file,
            offset: 0,
        }))
    }
    async fn upload(
        self: Arc<Self>,
        parent: &str,
        name: &str,
        size: u64,
    ) -> Result<Box<dyn TransferWriter>> {
        if !self.0.uploads_supported() {
            bail!("Uploads are unavailable through this adapter");
        }
        let mut handle = Handle::new(self.0.clone())?;
        call::<()>(
            &self.0,
            "files.upload.open",
            json!({"id":handle.id,"parent":parent,"name":name,"size":size}),
            true,
        )
        .await?;
        handle.ready = true;
        Ok(Box::new(Writer {
            handle,
            size,
            offset: 0,
        }))
    }
    async fn transfer_directory(
        self: Arc<Self>,
        path: &str,
        revision: &str,
    ) -> Result<Box<dyn TransferDirectory>> {
        if !self.supports_folders() {
            bail!("Folder transfers are unavailable through this adapter");
        }
        let mut handle = Handle::new(self.0.clone())?;
        call::<()>(
            &self.0,
            "files.directory.open",
            json!({"id":handle.id,"path":path,"revision":revision}),
            false,
        )
        .await?;
        handle.ready = true;
        Ok(Box::new(DirectoryReader { handle, eof: false }))
    }
    async fn transfer_mkdir(&self, parent: &str, name: &str) -> Result<FileLocation> {
        if !self.supports_folders() {
            bail!("Folder transfers are unavailable through this adapter");
        }
        location(
            call(
                &self.0,
                "files.transfer.mkdir",
                json!({"parent":parent,"name":name}),
                true,
            )
            .await?,
            true,
        )
    }
}
#[async_trait]
impl TransferReader for Reader {
    fn file(&self) -> TransferFile {
        self.file.clone()
    }
    async fn read(&mut self) -> Result<Vec<u8>> {
        self.handle.begin()?;
        let bytes: Vec<u8> = call(
            &self.handle.adapter,
            "files.download.read",
            json!({"id":self.handle.id,"offset":self.offset,"maxBytes":TRANSFER_CHUNK}),
            false,
        )
        .await?;
        if bytes.len() > TRANSFER_CHUNK
            || bytes.len() as u64 > self.file.size.saturating_sub(self.offset)
            || (bytes.is_empty() && self.offset != self.file.size)
        {
            bail!("Adapter download length changed or exceeded the chunk bound");
        }
        self.offset += bytes.len() as u64;
        self.handle.ready = true;
        Ok(bytes)
    }
    async fn finish(&mut self) -> Result<()> {
        self.handle.begin()?;
        if self.offset != self.file.size {
            bail!("Download has not received the declared file size");
        }
        call::<()>(
            &self.handle.adapter,
            "files.download.finish",
            json!({"id":self.handle.id}),
            false,
        )
        .await?;
        self.handle.complete();
        Ok(())
    }
    async fn abort(&mut self) -> Result<()> {
        self.handle.abort().await
    }
}
#[async_trait]
impl TransferWriter for Writer {
    async fn write(&mut self, bytes: &[u8]) -> Result<()> {
        if bytes.len() > TRANSFER_CHUNK
            || bytes.len() as u64 > self.size.saturating_sub(self.offset)
        {
            bail!("Upload exceeds its declared size or the chunk bound");
        }
        self.handle.begin()?;
        call::<()>(
            &self.handle.adapter,
            "files.upload.write",
            json!({"id":self.handle.id,"offset":self.offset,"bytes":bytes}),
            true,
        )
        .await?;
        self.offset += bytes.len() as u64;
        self.handle.ready = true;
        Ok(())
    }
    async fn finish(&mut self) -> Result<FileLocation> {
        self.handle.begin()?;
        if self.offset != self.size {
            bail!("Upload has not written the declared file size");
        }
        let result = location(
            call(
                &self.handle.adapter,
                "files.upload.finish",
                json!({"id":self.handle.id}),
                true,
            )
            .await?,
            true,
        )?;
        self.handle.complete();
        Ok(result)
    }
    async fn abort(&mut self) -> Result<()> {
        self.handle.abort().await
    }
}
#[async_trait]
impl TransferDirectory for DirectoryReader {
    async fn next(&mut self) -> Result<Vec<FileEntry>> {
        self.handle.begin()?;
        if self.eof {
            self.handle.ready = true;
            return Ok(vec![]);
        }
        let entries: Vec<FileEntry> = call(
            &self.handle.adapter,
            "files.directory.next",
            json!({"id":self.handle.id,"limit":TRANSFER_DIRECTORY_PAGE}),
            false,
        )
        .await?;
        if entries.len() > TRANSFER_DIRECTORY_PAGE
            || entries
                .iter()
                .any(|entry| entry.path.is_empty() || entry.revision.is_empty())
        {
            bail!("Adapter returned an invalid transfer directory page");
        }
        self.eof = entries.is_empty();
        self.handle.ready = true;
        Ok(entries)
    }
    async fn finish(&mut self) -> Result<()> {
        self.handle.begin()?;
        if !self.eof {
            bail!("Directory traversal has not reached its end");
        }
        call::<()>(
            &self.handle.adapter,
            "files.directory.finish",
            json!({"id":self.handle.id}),
            false,
        )
        .await?;
        self.handle.complete();
        Ok(())
    }
    async fn abort(&mut self) -> Result<()> {
        self.handle.abort().await
    }
}
