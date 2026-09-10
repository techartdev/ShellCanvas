// SPDX-License-Identifier: MPL-2.0
//! A mount captures its Files binding. Retired bindings never resolve a new host.
use super::*;

impl Binding {
    pub(super) fn mount_check(&self) -> FsResult<()> {
        self.check()
            .map_err(|error| FsError::new(FsErrorKind::Offline, error.to_string()))
    }
    async fn mount_run<T>(
        &self,
        write: bool,
        operation: impl Future<Output = FsResult<T>> + Send,
    ) -> FsResult<T> {
        self.mount_check()?;
        let result = operation.await;
        self.after(write)
            .map_err(|error| FsError::new(FsErrorKind::Offline, error.to_string()))?;
        result
    }
}

pub(super) struct FileSystem {
    binding: Binding,
    inner: Arc<dyn MountedFileSystem>,
    writable: bool,
}
impl FileSystem {
    pub(super) fn new(binding: Binding, inner: Arc<dyn MountedFileSystem>, writable: bool) -> Self {
        let writable = writable && inner.capabilities().writable;
        Self {
            binding,
            inner,
            writable,
        }
    }
}
fn write_allowed(writable: bool) -> FsResult<()> {
    if writable {
        Ok(())
    } else {
        Err(FsError::new(
            FsErrorKind::ReadOnly,
            "This attachment or handle is read-only",
        ))
    }
}
#[async_trait]
impl MountedFileSystem for FileSystem {
    fn check_available(&self) -> FsResult<()> {
        self.binding.mount_check()?;
        self.inner.check_available()
    }
    fn capabilities(&self) -> FsCapabilities {
        FsCapabilities {
            writable: self.writable,
            ..self.inner.capabilities()
        }
    }
    async fn space(&self, path: &MountPath) -> FsResult<FsSpace> {
        self.binding.mount_run(false, self.inner.space(path)).await
    }
    async fn metadata(&self, path: &MountPath) -> FsResult<FsMetadata> {
        self.binding
            .mount_run(false, self.inner.metadata(path))
            .await
    }
    async fn open(
        &self,
        path: &MountPath,
        options: FsOpenOptions,
    ) -> FsResult<Arc<dyn MountedFile>> {
        self.binding.mount_check()?;
        options.validate()?;
        if options.write || options.truncate || options.create != FsCreate::OpenExisting {
            write_allowed(self.writable)?;
        }
        let inner = self.inner.open(path, options).await?;
        if let Err(error) = self
            .binding
            .after(options.create != FsCreate::OpenExisting || options.truncate)
        {
            let _ = tokio::time::timeout(Duration::from_secs(3), inner.close()).await;
            return Err(FsError::new(FsErrorKind::Offline, error.to_string()));
        }
        Ok(Arc::new(File {
            binding: self.binding.clone(),
            inner,
            writable: self.writable && options.write,
            metadata_writable: self.writable,
        }))
    }
    async fn open_directory(&self, path: &MountPath) -> FsResult<Box<dyn MountedDirectory>> {
        self.binding.mount_check()?;
        let mut inner = self.inner.open_directory(path).await?;
        if let Err(error) = self.binding.mount_check() {
            let _ = tokio::time::timeout(Duration::from_secs(3), inner.close()).await;
            return Err(error);
        }
        Ok(Box::new(Directory {
            binding: self.binding.clone(),
            inner,
        }))
    }
    async fn set_metadata(&self, path: &MountPath, metadata: FsSetMetadata) -> FsResult<()> {
        write_allowed(self.writable)?;
        self.binding
            .mount_run(true, self.inner.set_metadata(path, metadata))
            .await
    }
    async fn mkdir(&self, path: &MountPath) -> FsResult<()> {
        write_allowed(self.writable)?;
        self.binding.mount_run(true, self.inner.mkdir(path)).await
    }
    async fn remove(&self, path: &MountPath, directory: bool) -> FsResult<()> {
        write_allowed(self.writable)?;
        self.binding
            .mount_run(true, self.inner.remove(path, directory))
            .await
    }
    async fn rename(&self, from: &MountPath, to: &MountPath, replace: bool) -> FsResult<()> {
        write_allowed(self.writable)?;
        self.binding
            .mount_run(true, self.inner.rename(from, to, replace))
            .await
    }
}
struct File {
    binding: Binding,
    inner: Arc<dyn MountedFile>,
    writable: bool,
    metadata_writable: bool,
}
#[async_trait]
impl MountedFile for File {
    async fn metadata(&self) -> FsResult<FsMetadata> {
        self.binding.mount_run(false, self.inner.metadata()).await
    }
    async fn read_at(&self, offset: u64, length: u32) -> FsResult<Vec<u8>> {
        self.binding
            .mount_run(false, self.inner.read_at(offset, length))
            .await
    }
    async fn write_at(&self, offset: u64, bytes: &[u8]) -> FsResult<()> {
        write_allowed(self.writable)?;
        self.binding
            .mount_run(true, self.inner.write_at(offset, bytes))
            .await
    }
    async fn set_metadata(&self, metadata: FsSetMetadata) -> FsResult<()> {
        write_allowed(self.metadata_writable)?;
        if metadata.size.is_some() {
            write_allowed(self.writable)?;
        }
        self.binding
            .mount_run(true, self.inner.set_metadata(metadata))
            .await
    }
    async fn flush(&self) -> FsResult<()> {
        self.binding.mount_run(true, self.inner.flush()).await
    }
    async fn close(&self) -> FsResult<()> {
        // Cleanup targets the captured handle even when its binding is retired.
        self.inner.close().await
    }
}
struct Directory {
    binding: Binding,
    inner: Box<dyn MountedDirectory>,
}
#[async_trait]
impl MountedDirectory for Directory {
    async fn next(&mut self) -> FsResult<Vec<FsDirectoryEntry>> {
        self.binding.mount_run(false, self.inner.next()).await
    }
    async fn close(&mut self) -> FsResult<()> {
        self.inner.close().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    struct Transport;
    #[async_trait]
    impl ConnectionLifecycle for Transport {
        fn is_connected(&self) -> bool {
            true
        }
        async fn disconnect(&self) -> Result<()> {
            Ok(())
        }
    }
    struct Handle {
        closes: AtomicUsize,
        metadata_writes: AtomicUsize,
    }
    #[async_trait]
    impl MountedFile for Handle {
        async fn metadata(&self) -> FsResult<FsMetadata> {
            Err(FsError::new(FsErrorKind::PermissionDenied, "fixture"))
        }
        async fn read_at(&self, _: u64, _: u32) -> FsResult<Vec<u8>> {
            Ok(vec![7])
        }
        async fn write_at(&self, _: u64, _: &[u8]) -> FsResult<()> {
            Ok(())
        }
        async fn set_metadata(&self, _: FsSetMetadata) -> FsResult<()> {
            self.metadata_writes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        async fn flush(&self) -> FsResult<()> {
            Ok(())
        }
        async fn close(&self) -> FsResult<()> {
            self.closes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    struct Root(Arc<Handle>);
    fn unsupported<T>() -> FsResult<T> {
        Err(FsError::new(
            FsErrorKind::Unsupported,
            "unused fixture operation",
        ))
    }
    #[async_trait]
    impl MountedFileSystem for Root {
        fn capabilities(&self) -> FsCapabilities {
            FsCapabilities {
                writable: true,
                atomic_replace: false,
                durable_flush: false,
            }
        }
        async fn metadata(&self, _: &MountPath) -> FsResult<FsMetadata> {
            unsupported()
        }
        async fn open(&self, _: &MountPath, _: FsOpenOptions) -> FsResult<Arc<dyn MountedFile>> {
            Ok(self.0.clone())
        }
        async fn open_directory(&self, _: &MountPath) -> FsResult<Box<dyn MountedDirectory>> {
            unsupported()
        }
        async fn set_metadata(&self, _: &MountPath, _: FsSetMetadata) -> FsResult<()> {
            unsupported()
        }
        async fn mkdir(&self, _: &MountPath) -> FsResult<()> {
            unsupported()
        }
        async fn remove(&self, _: &MountPath, _: bool) -> FsResult<()> {
            unsupported()
        }
        async fn rename(&self, _: &MountPath, _: &MountPath, _: bool) -> FsResult<()> {
            unsupported()
        }
    }
    #[tokio::test]
    async fn retired_mount_refuses_io_but_keeps_cleanup_and_typed_errors() {
        let binding = Binding {
            alive: Arc::new(AtomicBool::new(true)),
            source: ConnectionResource::new(
                ConnectionIdentity {
                    instance: 1,
                    generation: 1,
                    adapter: "fixture".into(),
                },
                Arc::new(Transport),
            ),
            role: "files",
        };
        let inner = Arc::new(Handle {
            closes: AtomicUsize::new(0),
            metadata_writes: AtomicUsize::new(0),
        });
        let path = MountPath::root().child("file").unwrap();
        let read_options = FsOpenOptions {
            read: true,
            write: false,
            create: FsCreate::OpenExisting,
            truncate: false,
        };
        let root = Arc::new(Root(inner.clone()));
        let writable_root = FileSystem::new(binding.clone(), root.clone(), true);
        let file = writable_root
            .open(
                &path,
                FsOpenOptions {
                    write: true,
                    ..read_options
                },
            )
            .await
            .unwrap();
        let read_only = FileSystem::new(binding.clone(), root, false)
            .open(&path, read_options)
            .await
            .unwrap();
        let attributes_only = writable_root.open(&path, read_options).await.unwrap();
        for metadata in [
            FsSetMetadata {
                permissions: Some(0o444),
                ..Default::default()
            },
            FsSetMetadata {
                modified: Some(1_600_000_123),
                ..Default::default()
            },
        ] {
            attributes_only.set_metadata(metadata).await.unwrap();
        }
        assert_eq!(inner.metadata_writes.load(Ordering::SeqCst), 2);
        assert_eq!(
            attributes_only
                .set_metadata(FsSetMetadata {
                    size: Some(0),
                    permissions: Some(0o444),
                    ..Default::default()
                })
                .await
                .unwrap_err()
                .kind,
            FsErrorKind::ReadOnly
        );
        assert_eq!(
            attributes_only.write_at(0, &[8]).await.unwrap_err().kind,
            FsErrorKind::ReadOnly
        );
        assert_eq!(
            inner.metadata_writes.load(Ordering::SeqCst),
            2,
            "Rejected truncation forwarded a partial metadata change"
        );
        assert_eq!(
            read_only.write_at(0, &[8]).await.unwrap_err().kind,
            FsErrorKind::ReadOnly
        );
        assert_eq!(
            read_only
                .set_metadata(FsSetMetadata::default())
                .await
                .unwrap_err()
                .kind,
            FsErrorKind::ReadOnly
        );
        assert_eq!(read_only.read_at(0, 1).await.unwrap(), vec![7]);
        assert_eq!(
            inner.metadata_writes.load(Ordering::SeqCst),
            2,
            "Read-only mount forwarded a metadata update"
        );
        assert_eq!(
            file.metadata().await.unwrap_err().kind,
            FsErrorKind::PermissionDenied
        );
        assert_eq!(file.read_at(0, 1).await.unwrap(), vec![7]);
        // Retirement during an acknowledged write must report uncertainty.
        let retired = binding.clone();
        let error = binding
            .mount_run(true, async move {
                retired.alive.store(false, Ordering::Release);
                Ok(())
            })
            .await
            .unwrap_err();
        assert_eq!(error.kind, FsErrorKind::Offline);
        assert!(error.message.contains("uncertain"));
        assert_eq!(
            file.read_at(0, 1).await.unwrap_err().kind,
            FsErrorKind::Offline
        );
        assert_eq!(
            file.write_at(0, &[8]).await.unwrap_err().kind,
            FsErrorKind::Offline
        );
        assert_eq!(
            attributes_only
                .set_metadata(FsSetMetadata {
                    modified: Some(1_600_000_124),
                    ..Default::default()
                })
                .await
                .unwrap_err()
                .kind,
            FsErrorKind::Offline
        );
        assert_eq!(
            inner.metadata_writes.load(Ordering::SeqCst),
            2,
            "Retired binding forwarded a metadata update"
        );
        file.close().await.unwrap();
        assert_eq!(inner.closes.load(Ordering::SeqCst), 1);
    }
}
