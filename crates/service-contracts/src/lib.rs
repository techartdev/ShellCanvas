// SPDX-License-Identifier: MPL-2.0
//! Transport-independent file, console, device inspection and host-settings services. Paths are nonempty provider-owned tokens;
//! consumers display/pass them unchanged and never split, join or normalize them.
use anyhow::Result;
use async_trait::async_trait;
pub mod connection;
pub mod custom;
pub use custom::*;
pub mod copy;
pub use connection::*;
pub use copy::*;
pub mod device;
pub use device::*;
pub mod directory;
pub use directory::*;
pub mod terminal;
pub use terminal::*;
pub mod settings;
use serde::{Deserialize, Serialize};
pub use settings::*;
use std::sync::Arc;

/// Maximum bytes per transfer operation; consumers and providers both enforce it.
pub const TRANSFER_CHUNK: usize = 32 * 1024;
pub const TRANSFER_DIRECTORY_PAGE: usize = 128;
/// A single open directory, read incrementally. Empty means EOF; implementations
/// release their handle on finish/abort and when abandoned.
#[async_trait]
pub trait TransferDirectory: Send {
    async fn next(&mut self) -> Result<Vec<FileEntry>>;
    async fn finish(&mut self) -> Result<()>;
    async fn abort(&mut self) -> Result<()>;
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TransferFile {
    pub location: FileLocation,
    pub size: u64,
}
#[async_trait]
pub trait TransferReader: Send {
    fn file(&self) -> TransferFile;
    /// Empty means EOF. Never returns more than TRANSFER_CHUNK bytes.
    async fn read(&mut self) -> Result<Vec<u8>>;
    /// Verify the source remained stable and close its handle.
    async fn finish(&mut self) -> Result<()>;
    async fn abort(&mut self) -> Result<()>;
}
#[async_trait]
pub trait TransferWriter: Send {
    async fn write(&mut self, bytes: &[u8]) -> Result<()>;
    /// Publish a completed file without replacing an existing destination.
    async fn finish(&mut self) -> Result<FileLocation>;
    /// Release resources and remove this transfer's unpublished temporary data.
    async fn abort(&mut self) -> Result<()>;
}
#[async_trait]
pub trait FileTransferService: Send + Sync {
    /// Inspect one selected entry without materializing its parent directory.
    async fn transfer_entry(self: Arc<Self>, path: &str, revision: &str) -> Result<FileEntry> {
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
    /// Optional recursive-transfer operations. Providers keep all path handling.
    fn supports_folders(&self) -> bool {
        false
    }
    /// Open a real, revision-checked directory. Each next() returns at most
    /// TRANSFER_DIRECTORY_PAGE children, independent of directory size.
    async fn transfer_directory(
        self: Arc<Self>,
        _path: &str,
        _revision: &str,
    ) -> Result<Box<dyn TransferDirectory>> {
        anyhow::bail!("Folder transfers are unavailable on this device")
    }
    /// Create an absent directory, without merging or replacing anything.
    async fn transfer_mkdir(&self, _parent: &str, _name: &str) -> Result<FileLocation> {
        anyhow::bail!("Folder transfers are unavailable on this device")
    }
    async fn download(
        self: Arc<Self>,
        path: &str,
        revision: &str,
    ) -> Result<Box<dyn TransferReader>>;
    async fn upload(
        self: Arc<Self>,
        parent: &str,
        name: &str,
        size: u64,
    ) -> Result<Box<dyn TransferWriter>>;
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePlace {
    pub path: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLocation {
    pub path: String,
    pub name: String,
    pub parent: Option<String>,
}
/// Confirmed relocation of tracked opaque locations. The provider alone maps
/// descendants; consumers never infer ancestry by parsing a path.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelocatedLocation {
    pub previous: String,
    pub location: FileLocation,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRelocation {
    pub path: String,
    pub locations: Vec<RelocatedLocation>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub modified: Option<u32>,
    pub revision: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Directory {
    pub path: String,
    pub name: String,
    pub parent: Option<String>,
    pub home: Option<FilePlace>,
    pub roots: Vec<FilePlace>,
    pub entries: Vec<FileEntry>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
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
    /// Incremental scan with explicit ownership; None selects the default location.
    /// The default adapts older providers and still materializes their listing.
    async fn open_directory(
        self: Arc<Self>,
        path: Option<&str>,
    ) -> Result<Box<dyn DirectoryReader>> {
        Ok(Box::new(SnapshotDirectory::new(self.list(path).await?)))
    }
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
    async fn rename_entry(&self, path: &str, name: &str, revision: &str) -> Result<String> {
        Ok(self.rename_tracked(path, name, revision, &[]).await?.path)
    }
    async fn rename_tracked(
        &self,
        path: &str,
        name: &str,
        revision: &str,
        tracked: &[String],
    ) -> Result<FileRelocation>;
    async fn remove_entry(&self, path: &str, revision: &str) -> Result<()>;
}

/// Move within one filesystem service, preserving the item and refusing replacement.
/// Paths remain opaque; the provider resolves the destination folder and item name.
#[async_trait]
pub trait FileMoveService: Send + Sync {
    async fn move_entry(&self, path: &str, parent: &str, revision: &str) -> Result<String> {
        Ok(self.move_tracked(path, parent, revision, &[]).await?.path)
    }
    async fn move_tracked(
        &self,
        path: &str,
        parent: &str,
        revision: &str,
        tracked: &[String],
    ) -> Result<FileRelocation>;
}
