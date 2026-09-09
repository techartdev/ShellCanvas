// SPDX-License-Identifier: MPL-2.0
use crate::{Directory, FileEntry};
use anyhow::{bail, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// Bounds each delivery, never the number of entries in a directory.
pub const DIRECTORY_PAGE: usize = 128;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryPage {
    pub directory: Directory,
    pub done: bool,
}

/// A single provider-owned scan. Paths and ordering belong to the provider.
/// Poll sequentially. Dropping a pending next retires the reader: do not retry a
/// potentially advanced cursor. Close is idempotent and must remain available
/// after source retirement; implementations also release resources on Drop.
#[async_trait]
pub trait DirectoryReader: Send + Sync {
    async fn next(&mut self) -> Result<DirectoryPage>;
    async fn close(&mut self) -> Result<()>;
}

/// Compatibility for providers implementing only the original list contract.
/// Production providers should override open_directory to fetch on demand.
pub struct SnapshotDirectory {
    metadata: Directory,
    entries: VecDeque<FileEntry>,
    closed: bool,
}
impl SnapshotDirectory {
    pub fn new(mut directory: Directory) -> Self {
        let entries = std::mem::take(&mut directory.entries).into();
        Self {
            metadata: directory,
            entries,
            closed: false,
        }
    }
}
#[async_trait]
impl DirectoryReader for SnapshotDirectory {
    async fn next(&mut self) -> Result<DirectoryPage> {
        if self.closed {
            bail!("Directory reader is closed");
        }
        let mut directory = self.metadata.clone();
        directory.entries = self
            .entries
            .drain(..self.entries.len().min(DIRECTORY_PAGE))
            .collect();
        let done = self.entries.is_empty();
        self.closed = done;
        Ok(DirectoryPage { directory, done })
    }
    async fn close(&mut self) -> Result<()> {
        self.closed = true;
        self.entries.clear();
        Ok(())
    }
}

/// Explicit materialization for legacy consumers. Incremental consumers retain
/// the reader and ask for another page only when they need one.
pub async fn collect_directory(mut reader: Box<dyn DirectoryReader>) -> Result<Directory> {
    let result = async {
        let mut result: Option<Directory> = None;
        loop {
            let page = reader.next().await?;
            if page.directory.entries.len() > DIRECTORY_PAGE
                || (!page.done && page.directory.entries.is_empty())
            {
                bail!("Invalid directory page");
            }
            if let Some(directory) = &mut result {
                if directory.path != page.directory.path {
                    bail!("Directory changed during listing");
                }
                directory.entries.extend(page.directory.entries);
            } else {
                result = Some(page.directory);
            }
            if page.done {
                return Ok(result.expect("first page"));
            }
        }
    }
    .await;
    let cleanup = reader.close().await;
    let directory = result?;
    cleanup?;
    Ok(directory)
}
