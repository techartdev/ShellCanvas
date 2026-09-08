// SPDX-License-Identifier: MPL-2.0
use crate::connection_resource::{ConnectionLease, ConnectionResource};
use anyhow::{bail, Result};
use async_trait::async_trait;
use shellcanvas_services::*;
use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

#[derive(Clone)]
struct Binding {
    workspace: Arc<AtomicBool>,
    source: Arc<ConnectionResource>,
    role: &'static str,
}
impl Binding {
    fn check(&self) -> Result<()> {
        if !self.workspace.load(Ordering::Acquire) {
            bail!("The workspace owning this service is closed");
        }
        if !self.source.is_connected() {
            bail!(
                "{} connection is disconnected ({})",
                self.role,
                self.source.identity().adapter
            );
        }
        Ok(())
    }
    async fn run<R>(
        &self,
        write: bool,
        operation: impl Future<Output = Result<R>> + Send,
    ) -> Result<R> {
        self.check()?;
        let result = operation.await;
        self.after(write)?;
        result
    }
    fn after(&self, write: bool) -> Result<()> {
        self.check().map_err(|error| {
            if write {
                anyhow::anyhow!(
                    "{error}. The remote operation outcome is uncertain; inspect before retrying."
                )
            } else {
                error
            }
        })
    }
}
struct Bound<T: ?Sized> {
    binding: Binding,
    service: Arc<T>,
}

pub struct WorkspaceServices {
    alive: Arc<AtomicBool>,
    connections: Vec<ConnectionLease>,
    file_source: Option<Arc<ConnectionResource>>,
    pub terminal: Option<Arc<dyn TerminalService>>,
    pub files: Option<Arc<dyn FileSystemProvider>>,
    pub text: Option<Arc<dyn TextFileService>>,
    pub mutations: Option<Arc<dyn FileMutationService>>,
    pub moves: Option<Arc<dyn FileMoveService>>,
    pub transfers: Option<Arc<dyn FileTransferService>>,
    pub settings: Option<Arc<dyn HostSettingsService>>,
}
macro_rules! bind_role {
    ($method:ident, $field:ident, $service:ident, $files:literal) => {
        pub fn $method(
            &mut self,
            source: &Arc<ConnectionResource>,
            service: Arc<dyn $service>,
        ) -> Result<(), String> {
            if self.$field.is_some() {
                return Err(concat!(stringify!($field), " already has an explicit binding").into());
            }
            if !self
                .connections
                .iter()
                .any(|lease| Arc::ptr_eq(lease.resource(), source))
            {
                return Err("The selected service source is not owned by this workspace".into());
            }
            if $files {
                if self.file_source.as_ref().is_some_and(|selected| !Arc::ptr_eq(selected, source)) {
                    return Err("File services must share one explicit source; cross-source path mapping is unavailable".into());
                }
                self.file_source = Some(source.clone());
            }
            self.$field = Some(Arc::new(Bound {
                binding: Binding {
                    workspace: self.alive.clone(),
                    source: source.clone(),
                    role: stringify!($field),
                },
                service,
            }));
            Ok(())
        }
    };
}
impl WorkspaceServices {
    pub fn new(sources: Vec<Arc<ConnectionResource>>) -> Result<Self, String> {
        let mut connections: Vec<ConnectionLease> = Vec::new();
        for source in sources {
            if let Some(existing) = connections
                .iter()
                .find(|lease| lease.resource().identity().instance == source.identity().instance)
            {
                if Arc::ptr_eq(existing.resource(), &source) {
                    continue;
                }
                return Err("Conflicting connection instances in workspace".into());
            }
            connections.push(source.lease()?);
        }
        Ok(Self {
            alive: Arc::new(AtomicBool::new(true)),
            connections,
            file_source: None,
            terminal: None,
            files: None,
            text: None,
            mutations: None,
            moves: None,
            transfers: None,
            settings: None,
        })
    }
    pub fn identities(&self) -> Vec<ConnectionIdentity> {
        self.connections
            .iter()
            .map(|lease| lease.resource().identity().clone())
            .collect()
    }
    pub fn is_connected(&self) -> bool {
        self.alive.load(Ordering::Acquire)
            && self
                .connections
                .iter()
                .any(|lease| lease.resource().is_connected())
    }
    pub async fn disconnect(mut self) -> Result<(), String> {
        self.alive.store(false, Ordering::Release);
        let mut tasks = tokio::task::JoinSet::new();
        for lease in self.connections.drain(..) {
            tasks.spawn(lease.close());
        }
        let mut errors = Vec::new();
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => errors.push(error),
                Err(_) => errors.push("Connection cleanup task failed".into()),
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
    bind_role!(bind_terminal, terminal, TerminalService, false);
    bind_role!(bind_files, files, FileSystemProvider, true);
    bind_role!(bind_text, text, TextFileService, true);
    bind_role!(bind_mutations, mutations, FileMutationService, true);
    bind_role!(bind_moves, moves, FileMoveService, true);
    bind_role!(bind_transfers, transfers, FileTransferService, true);
    bind_role!(bind_settings, settings, HostSettingsService, false);
}
impl Drop for WorkspaceServices {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
    }
}

#[async_trait]
impl FileSystemProvider for Bound<dyn FileSystemProvider> {
    async fn list(&self, path: Option<&str>) -> Result<Directory> {
        self.binding.run(false, self.service.list(path)).await
    }
    async fn locate(&self, path: &str) -> Result<FileLocation> {
        self.binding.run(false, self.service.locate(path)).await
    }
    async fn preview(&self, path: &str) -> Result<String> {
        self.binding.run(false, self.service.preview(path)).await
    }
}
#[async_trait]
impl TextFileService for Bound<dyn TextFileService> {
    async fn read_text(&self, path: &str) -> Result<TextDocument> {
        self.binding.run(false, self.service.read_text(path)).await
    }
    async fn create_text(&self, parent: &str, name: &str, text: &str) -> Result<TextDocument> {
        self.binding
            .run(true, self.service.create_text(parent, name, text))
            .await
    }
    async fn save_text(&self, path: &str, text: &str, revision: &str) -> Result<TextDocument> {
        self.binding
            .run(true, self.service.save_text(path, text, revision))
            .await
    }
}
#[async_trait]
impl FileMutationService for Bound<dyn FileMutationService> {
    async fn make_directory(&self, parent: &str, name: &str) -> Result<String> {
        self.binding
            .run(true, self.service.make_directory(parent, name))
            .await
    }
    async fn rename_tracked(
        &self,
        path: &str,
        name: &str,
        revision: &str,
        tracked: &[String],
    ) -> Result<FileRelocation> {
        self.binding
            .run(
                true,
                self.service.rename_tracked(path, name, revision, tracked),
            )
            .await
    }
    async fn remove_entry(&self, path: &str, revision: &str) -> Result<()> {
        self.binding
            .run(true, self.service.remove_entry(path, revision))
            .await
    }
}
#[async_trait]
impl FileMoveService for Bound<dyn FileMoveService> {
    async fn move_tracked(
        &self,
        path: &str,
        parent: &str,
        revision: &str,
        tracked: &[String],
    ) -> Result<FileRelocation> {
        self.binding
            .run(
                true,
                self.service.move_tracked(path, parent, revision, tracked),
            )
            .await
    }
}
#[async_trait]
impl HostSettingsService for Bound<dyn HostSettingsService> {
    async fn read(&self) -> Result<Vec<HostSetting>> {
        self.binding.run(false, self.service.read()).await
    }
    async fn apply(&self, id: &str, value: &str, revision: &str) -> Result<HostSetting> {
        self.binding
            .run(true, self.service.apply(id, value, revision))
            .await
    }
}

struct Reader {
    binding: Binding,
    inner: Box<dyn TerminalReader>,
}
struct Writer {
    binding: Binding,
    inner: Box<dyn TerminalWriter>,
}
#[async_trait]
impl TerminalReader for Reader {
    async fn read(&mut self) -> Result<Option<Vec<u8>>> {
        self.binding.run(false, self.inner.read()).await
    }
}
#[async_trait]
impl TerminalWriter for Writer {
    async fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.binding.run(true, self.inner.write(bytes)).await
    }
    async fn resize(&mut self, size: TerminalSize) -> Result<()> {
        self.binding.run(true, self.inner.resize(size)).await
    }
    async fn close(&mut self) -> Result<()> {
        self.inner.close().await
    }
}
#[async_trait]
impl TerminalService for Bound<dyn TerminalService> {
    async fn open(&self, size: TerminalSize) -> Result<TerminalStream> {
        self.binding.check()?;
        let mut stream = self.service.open(size).await?;
        if let Err(error) = self.binding.after(false) {
            let _ = tokio::time::timeout(Duration::from_secs(3), stream.writer.close()).await;
            return Err(error);
        }
        Ok(TerminalStream {
            reader: Box::new(Reader {
                binding: self.binding.clone(),
                inner: stream.reader,
            }),
            writer: Box::new(Writer {
                binding: self.binding.clone(),
                inner: stream.writer,
            }),
            resizable: stream.resizable,
        })
    }
}

struct Download {
    binding: Binding,
    inner: Box<dyn TransferReader>,
}
struct Upload {
    binding: Binding,
    inner: Box<dyn TransferWriter>,
}
#[async_trait]
impl TransferReader for Download {
    fn file(&self) -> TransferFile {
        self.inner.file()
    }
    async fn read(&mut self) -> Result<Vec<u8>> {
        self.binding.run(false, self.inner.read()).await
    }
    async fn finish(&mut self) -> Result<()> {
        self.binding.run(false, self.inner.finish()).await
    }
    async fn abort(&mut self) -> Result<()> {
        self.inner.abort().await
    }
}
#[async_trait]
impl TransferWriter for Upload {
    async fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.binding.run(true, self.inner.write(bytes)).await
    }
    async fn finish(&mut self) -> Result<FileLocation> {
        self.binding.run(true, self.inner.finish()).await
    }
    async fn abort(&mut self) -> Result<()> {
        self.inner.abort().await
    }
}
#[async_trait]
impl FileTransferService for Bound<dyn FileTransferService> {
    async fn download(
        self: Arc<Self>,
        path: &str,
        revision: &str,
    ) -> Result<Box<dyn TransferReader>> {
        self.binding.check()?;
        let mut inner = self.service.clone().download(path, revision).await?;
        if let Err(error) = self.binding.after(false) {
            let _ = tokio::time::timeout(Duration::from_secs(3), inner.abort()).await;
            return Err(error);
        }
        Ok(Box::new(Download {
            binding: self.binding.clone(),
            inner,
        }))
    }
    async fn upload(
        self: Arc<Self>,
        parent: &str,
        name: &str,
        size: u64,
    ) -> Result<Box<dyn TransferWriter>> {
        self.binding.check()?;
        let mut inner = self.service.clone().upload(parent, name, size).await?;
        if let Err(error) = self.binding.after(true) {
            let _ = tokio::time::timeout(Duration::from_secs(3), inner.abort()).await;
            return Err(error);
        }
        Ok(Box::new(Upload {
            binding: self.binding.clone(),
            inner,
        }))
    }
}

#[cfg(test)]
#[path = "workspace_services_tests.rs"]
mod tests;
