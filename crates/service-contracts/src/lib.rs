// SPDX-License-Identifier: MPL-2.0
//! Transport-independent file services. Paths are nonempty provider-owned tokens;
//! consumers display/pass them unchanged and never split, join or normalize them.
use anyhow::Result;
use async_trait::async_trait;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePlace {
    pub path: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLocation {
    pub path: String,
    pub name: String,
    pub parent: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub modified: Option<u32>,
    pub revision: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Directory {
    pub path: String,
    pub name: String,
    pub parent: Option<String>,
    pub home: Option<FilePlace>,
    pub roots: Vec<FilePlace>,
    pub entries: Vec<FileEntry>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDocument {
    pub path: String,
    pub name: String,
    pub parent: Option<String>,
    pub text: String,
    pub revision: String,
    pub writable: bool,
}

#[async_trait]
pub trait FileSystemProvider: Send + Sync {
    /// None selects the provider's default location, not an assumed dot or root.
    async fn list(&self, path: Option<&str>) -> Result<Directory>;
    async fn locate(&self, path: &str) -> Result<FileLocation>;
    async fn preview(&self, path: &str) -> Result<String>;
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
#[async_trait]
pub trait FileMutationService: Send + Sync {
    async fn make_directory(&self, parent: &str, name: &str) -> Result<String>;
    async fn rename_entry(&self, path: &str, name: &str, revision: &str) -> Result<String>;
    async fn remove_entry(&self, path: &str, revision: &str) -> Result<()>;
}
