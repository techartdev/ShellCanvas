// SPDX-License-Identifier: MPL-2.0
//! Standard service bridges. Unknown namespaces remain callable through AdapterProcess::call.
use crate::AdapterProcess;
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use shellcanvas_services::*;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
const OPERATION: Duration = Duration::from_secs(30);
const FILE_METHODS: &[&str] = &["files.list", "files.locate", "files.preview"];
const CONSOLE_METHODS: &[&str] = &[
    "console.open",
    "console.read",
    "console.write",
    "console.close",
];
impl AdapterProcess {
    /// Presence means an exact supported contract, not merely a similarly named capability.
    pub fn files(&self) -> Option<Arc<dyn FileSystemProvider>> {
        self.supports("files", 1, FILE_METHODS)
            .then(|| Arc::new(Files(self.clone())) as Arc<dyn FileSystemProvider>)
    }
    pub fn terminal(&self) -> Option<Arc<dyn TerminalService>> {
        self.supports("console", 1, CONSOLE_METHODS)
            .then(|| Arc::new(Console(self.clone())) as Arc<dyn TerminalService>)
    }
}
struct Files(AdapterProcess);
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DirectoryPage {
    directory: Directory,
    next: Option<String>,
}
#[async_trait]
impl FileSystemProvider for Files {
    async fn list(&self, path: Option<&str>) -> Result<Directory> {
        // The current browser contract still returns a materialized directory. Wire pages have
        // no total-entry ceiling; transfer traversal will use its own incremental reader bridge.
        let operation = async {
            let mut cursor: Option<String> = None;
            let mut directory: Option<Directory> = None;
            loop {
                let page: DirectoryPage = serde_json::from_value(
                    self.0
                        .call(
                            "files.list",
                            json!({"path":path,"cursor":cursor,"limit":TRANSFER_DIRECTORY_PAGE}),
                            OPERATION,
                        )
                        .await?,
                )
                .context("Invalid directory page from adapter")?;
                if page.directory.path.is_empty()
                    || page.directory.entries.len() > TRANSFER_DIRECTORY_PAGE
                {
                    bail!("Invalid directory page from adapter");
                }
                if page
                    .next
                    .as_ref()
                    .is_some_and(|next| next.is_empty() || Some(next) == cursor.as_ref())
                {
                    bail!("The directory cursor did not advance");
                }
                if let Some(existing) = &mut directory {
                    if existing.path != page.directory.path {
                        bail!("The adapter changed directory during listing");
                    }
                    existing.entries.extend(page.directory.entries);
                } else {
                    directory = Some(page.directory);
                }
                cursor = page.next;
                if cursor.is_none() {
                    return Ok(directory.expect("first page"));
                }
            }
        };
        tokio::time::timeout(OPERATION, operation)
            .await
            .context("Directory listing timed out")?
    }
    async fn locate(&self, path: &str) -> Result<FileLocation> {
        let location: FileLocation = serde_json::from_value(
            self.0
                .call("files.locate", json!({"path":path}), OPERATION)
                .await?,
        )?;
        if location.path.is_empty() {
            bail!("Adapter returned an empty file location");
        }
        Ok(location)
    }
    async fn preview(&self, path: &str) -> Result<String> {
        Ok(serde_json::from_value(
            self.0
                .call("files.preview", json!({"path":path}), OPERATION)
                .await?,
        )?)
    }
}
struct Console(AdapterProcess);
struct Handle {
    adapter: AdapterProcess,
    id: String,
    closed: AtomicBool,
    runtime: tokio::runtime::Handle,
    outcome: tokio::sync::watch::Sender<Option<std::result::Result<(), String>>>,
}
impl Handle {
    fn check(&self) -> Result<()> {
        if self.closed.load(Ordering::Acquire) || !self.adapter.connected() {
            bail!("This adapter console is closed");
        }
        Ok(())
    }
    fn begin_close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        let adapter = self.adapter.clone();
        let id = self.id.clone();
        let outcome = self.outcome.clone();
        self.runtime.spawn(async move {
            let result = adapter
                .call("console.close", json!({"id":id}), Duration::from_secs(3))
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());
            outcome.send_replace(Some(result));
        });
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        self.begin_close();
    }
}
struct Reader(Arc<Handle>);
struct Writer {
    handle: Arc<Handle>,
    resizable: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Opened {
    resizable: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConsoleRead {
    bytes: Vec<u8>,
    closed: bool,
}
#[async_trait]
impl TerminalService for Console {
    async fn open(&self, size: TerminalSize) -> Result<TerminalStream> {
        let handle = Arc::new(Handle {
            adapter: self.0.clone(),
            id: uuid::Uuid::new_v4().to_string(),
            closed: AtomicBool::new(false),
            runtime: tokio::runtime::Handle::current(),
            outcome: tokio::sync::watch::channel(None).0,
        });
        // The client chooses identity before opening, so cancellation/late opens can be closed.
        let size = TerminalSize::new(size.cols, size.rows);
        let opened: Opened = serde_json::from_value(
            self.0
                .call(
                    "console.open",
                    json!({"id":handle.id,"cols":size.cols,"rows":size.rows}),
                    OPERATION,
                )
                .await?,
        )?;
        let resizable = opened.resizable && self.0.supports("console", 1, &["console.resize"]);
        Ok(TerminalStream {
            reader: Box::new(Reader(handle.clone())),
            writer: Box::new(Writer { handle, resizable }),
            resizable,
        })
    }
}
#[async_trait]
impl TerminalReader for Reader {
    async fn read(&mut self) -> Result<Option<Vec<u8>>> {
        loop {
            self.0.check()?;
            let result: ConsoleRead = serde_json::from_value(
                self.0
                    .adapter
                    .call(
                        "console.read",
                        json!({"id":self.0.id,"maxBytes":TERMINAL_CHUNK,"waitMs":1000}),
                        OPERATION,
                    )
                    .await?,
            )?;
            self.0.check()?;
            if result.bytes.len() > TERMINAL_CHUNK {
                bail!("Adapter console exceeded its byte chunk limit");
            }
            if !result.bytes.is_empty() {
                return Ok(Some(result.bytes));
            }
            if result.closed {
                return Ok(None);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
#[async_trait]
impl TerminalWriter for Writer {
    async fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.handle.check()?;
        if bytes.len() > TERMINAL_CHUNK {
            bail!("Console input must be chunked");
        }
        self.handle
            .adapter
            .call(
                "console.write",
                json!({"id":self.handle.id,"bytes":bytes}),
                OPERATION,
            )
            .await?;
        self.handle
            .check()
            .context("Console write outcome is uncertain; do not retry")
    }
    async fn resize(&mut self, size: TerminalSize) -> Result<()> {
        self.handle.check()?;
        if !self.resizable {
            bail!("This console has a fixed size");
        }
        let size = TerminalSize::new(size.cols, size.rows);
        self.handle
            .adapter
            .call(
                "console.resize",
                json!({"id":self.handle.id,"cols":size.cols,"rows":size.rows}),
                OPERATION,
            )
            .await?;
        self.handle
            .check()
            .context("Console resize outcome is uncertain; do not retry")
    }
    async fn close(&mut self) -> Result<()> {
        self.handle.begin_close();
        let mut outcome = self.handle.outcome.subscribe();
        loop {
            if let Some(result) = outcome.borrow_and_update().clone() {
                return result.map_err(anyhow::Error::msg);
            }
            outcome
                .changed()
                .await
                .context("Console cleanup result is unavailable")?;
        }
    }
}
