// SPDX-License-Identifier: MPL-2.0
//! Optional filesystem projection for native local mounts. This is not the
//! sequential transfer API. A provider grants one root and owns remote paths.
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{fmt, sync::Arc};
pub mod bridge_control;
pub mod wire;

pub const MOUNT_IO_CHUNK: usize = 32 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum FsErrorKind {
    NotFound,
    PermissionDenied,
    AlreadyExists,
    NotDirectory,
    IsDirectory,
    NotEmpty,
    InvalidInput,
    Unsupported,
    ReadOnly,
    Offline,
    TimedOut,
    Io,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FsError {
    pub kind: FsErrorKind,
    pub message: String,
}
impl FsError {
    pub fn new(kind: FsErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}
impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for FsError {}
pub type FsResult<T> = Result<T, FsError>;

/// Relative components within the granted root. An empty path means that root.
/// OS backends translate their local separators; providers translate these
/// components to their own namespace. No drive prefixes or parent traversal.
#[derive(Clone, Debug, Default, Eq, PartialEq, Hash, Serialize, Deserialize)]
#[serde(try_from = "Vec<String>", into = "Vec<String>")]
pub struct MountPath(Vec<String>);
impl TryFrom<Vec<String>> for MountPath {
    type Error = FsError;
    fn try_from(names: Vec<String>) -> FsResult<Self> {
        names
            .iter()
            .try_fold(Self::root(), |path, name| path.child(name))
    }
}
impl From<MountPath> for Vec<String> {
    fn from(path: MountPath) -> Self {
        path.0
    }
}
impl MountPath {
    pub fn root() -> Self {
        Self::default()
    }
    pub fn components(&self) -> &[String] {
        &self.0
    }
    pub fn child(&self, name: &str) -> FsResult<Self> {
        if name.is_empty() || matches!(name, "." | "..") || name.contains(['/', '\\', '\0', ':']) {
            return Err(FsError::new(
                FsErrorKind::InvalidInput,
                "Invalid mounted filename",
            ));
        }
        let mut path = self.0.clone();
        path.push(name.into());
        Ok(Self(path))
    }
    pub fn parent(&self) -> Option<Self> {
        (!self.0.is_empty()).then(|| Self(self.0[..self.0.len() - 1].to_vec()))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum FsKind {
    File,
    Directory,
    Symlink,
    Other,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FsMetadata {
    pub kind: FsKind,
    pub size: u64,
    /// Unix seconds; absent timestamps must not be invented by the provider.
    pub accessed: Option<u64>,
    pub modified: Option<u64>,
    pub permissions: Option<u32>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FsDirectoryEntry {
    pub name: String,
    pub metadata: FsMetadata,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FsSpace {
    pub block_size: u64,
    pub blocks: u64,
    pub blocks_free: u64,
    pub blocks_available: u64,
    pub files: u64,
    pub files_free: u64,
    pub name_max: u64,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct FsCapabilities {
    pub writable: bool,
    pub atomic_replace: bool,
    pub durable_flush: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum FsCreate {
    OpenExisting,
    CreateNew,
    OpenOrCreate,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct FsOpenOptions {
    pub read: bool,
    pub write: bool,
    pub create: FsCreate,
    pub truncate: bool,
}
impl FsOpenOptions {
    pub fn validate(self) -> FsResult<()> {
        if !self.write && (!self.read || self.truncate || self.create != FsCreate::OpenExisting) {
            return Err(FsError::new(
                FsErrorKind::InvalidInput,
                "Invalid file open options",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct FsSetMetadata {
    pub size: Option<u64>,
    pub accessed: Option<u64>,
    pub modified: Option<u64>,
    pub permissions: Option<u32>,
}

/// Each call consumes at most MOUNT_IO_CHUNK bytes. Writes are acknowledged
/// before returning. Native backends split larger requests. Handles never
/// migrate to a reconnected source. Close/drop release resources, not upload.
#[async_trait]
pub trait MountedFile: Send + Sync {
    async fn metadata(&self) -> FsResult<FsMetadata>;
    async fn read_at(&self, offset: u64, length: u32) -> FsResult<Vec<u8>>;
    async fn write_at(&self, offset: u64, bytes: &[u8]) -> FsResult<()>;
    async fn set_metadata(&self, metadata: FsSetMetadata) -> FsResult<()>;
    /// A provider without durable_flush only guarantees acknowledged writes.
    async fn flush(&self) -> FsResult<()>;
    async fn close(&self) -> FsResult<()>;
}
#[async_trait]
pub trait MountedDirectory: Send {
    /// Incremental server batches; empty means EOF. No total directory cap.
    async fn next(&mut self) -> FsResult<Vec<FsDirectoryEntry>>;
    async fn close(&mut self) -> FsResult<()>;
}
#[async_trait]
pub trait MountedFileSystem: Send + Sync {
    /// Cheap lifecycle check, including heartbeats that perform no file I/O.
    fn check_available(&self) -> FsResult<()> {
        Ok(())
    }
    fn capabilities(&self) -> FsCapabilities;
    async fn space(&self, _path: &MountPath) -> FsResult<FsSpace> {
        Err(FsError::new(
            FsErrorKind::Unsupported,
            "Remote capacity reporting is unavailable",
        ))
    }
    async fn metadata(&self, path: &MountPath) -> FsResult<FsMetadata>;
    async fn open(
        &self,
        path: &MountPath,
        options: FsOpenOptions,
    ) -> FsResult<Arc<dyn MountedFile>>;
    async fn open_directory(&self, path: &MountPath) -> FsResult<Box<dyn MountedDirectory>>;
    async fn set_metadata(&self, path: &MountPath, metadata: FsSetMetadata) -> FsResult<()>;
    async fn mkdir(&self, path: &MountPath) -> FsResult<()>;
    async fn remove(&self, path: &MountPath, directory: bool) -> FsResult<()>;
    async fn rename(&self, from: &MountPath, to: &MountPath, replace: bool) -> FsResult<()>;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mount_paths_cannot_escape_or_inject_native_namespaces() {
        for name in [
            "",
            ".",
            "..",
            "../outside",
            "a/b",
            "a\\b",
            "C:",
            "file:stream",
            "nul\0",
        ] {
            assert!(MountPath::root().child(name).is_err(), "{name:?}");
        }
        let path = MountPath::root()
            .child("資料")
            .unwrap()
            .child("hello world.txt")
            .unwrap();
        assert_eq!(path.components(), &["資料", "hello world.txt"]);
        assert_eq!(path.parent().unwrap().parent().unwrap(), MountPath::root());
        assert!(MountPath::root().parent().is_none());
    }
}
