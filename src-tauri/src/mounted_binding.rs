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
}
impl FileSystem {
    pub(super) fn new(binding: Binding, inner: Arc<dyn MountedFileSystem>) -> Self {
        Self { binding, inner }
    }
}
#[async_trait]
impl MountedFileSystem for FileSystem {
    fn check_available(&self) -> FsResult<()> {
        self.binding.mount_check()?;
        self.inner.check_available()
    }
    fn capabilities(&self) -> FsCapabilities {
        self.inner.capabilities()
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
        self.binding
            .mount_run(true, self.inner.set_metadata(path, metadata))
            .await
    }
    async fn mkdir(&self, path: &MountPath) -> FsResult<()> {
        self.binding.mount_run(true, self.inner.mkdir(path)).await
    }
    async fn remove(&self, path: &MountPath, directory: bool) -> FsResult<()> {
        self.binding
            .mount_run(true, self.inner.remove(path, directory))
            .await
    }
    async fn rename(&self, from: &MountPath, to: &MountPath, replace: bool) -> FsResult<()> {
        self.binding
            .mount_run(true, self.inner.rename(from, to, replace))
            .await
    }
}
struct File {
    binding: Binding,
    inner: Arc<dyn MountedFile>,
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
        self.binding
            .mount_run(true, self.inner.write_at(offset, bytes))
            .await
    }
    async fn set_metadata(&self, metadata: FsSetMetadata) -> FsResult<()> {
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
        });
        let file = File {
            binding: binding.clone(),
            inner: inner.clone(),
        };
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
        file.close().await.unwrap();
        assert_eq!(inner.closes.load(Ordering::SeqCst), 1);
    }
}
