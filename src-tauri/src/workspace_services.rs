// SPDX-License-Identifier: MPL-2.0
use crate::connection_resource::{ConnectionLease, ConnectionResource};
use anyhow::{bail, Result};
use async_trait::async_trait;
use shellcanvas_services::*;
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    capability: &'static str,
    state: &'static str,
    reason: Option<String>,
    source: Option<ConnectionIdentity>,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatus {
    pub connected: bool,
    pub services: Vec<ServiceStatus>,
    pub custom_sources: std::collections::BTreeMap<String, ConnectionIdentity>,
}

#[derive(Clone)]
struct Binding {
    alive: Arc<AtomicBool>,
    source: Arc<ConnectionResource>,
    role: &'static str,
}
impl Binding {
    fn check(&self) -> Result<()> {
        if !self.alive.load(Ordering::Acquire) {
            bail!("The workspace service binding is closed");
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

struct OwnedSource {
    lease: ConnectionLease,
    alive: Arc<AtomicBool>,
}
impl OwnedSource {
    fn resource(&self) -> &Arc<ConnectionResource> {
        self.lease.resource()
    }
}

/// A selected service family, including families the source cannot currently supply.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum ServiceRole {
    Files,
    Console,
    HostSettings,
    Custom(String),
}
impl ServiceRole {
    fn standard(field: &str) -> Self {
        match field {
            "terminal" => Self::Console,
            "settings" => Self::HostSettings,
            _ => Self::Files,
        }
    }
}

pub struct WorkspaceServices {
    alive: Arc<AtomicBool>,
    connections: Vec<OwnedSource>,
    generations: HashMap<u64, u64>,
    replaced: HashSet<ServiceRole>,
    selected: HashMap<ServiceRole, Arc<ConnectionResource>>,
    sources: HashMap<&'static str, Arc<ConnectionResource>>,
    advertised: Option<HashSet<String>>,
    custom: Vec<Arc<crate::custom_binding::CustomBinding>>,
    pub terminal: Option<Arc<dyn TerminalService>>,
    pub files: Option<Arc<dyn FileSystemProvider>>,
    pub text: Option<Arc<dyn TextFileService>>,
    pub mutations: Option<Arc<dyn FileMutationService>>,
    pub moves: Option<Arc<dyn FileMoveService>>,
    pub transfers: Option<Arc<dyn FileTransferService>>,
    pub settings: Option<Arc<dyn HostSettingsService>>,
}
macro_rules! bind_role {
    ($method:ident, $field:ident, $service:ident) => {
        pub fn $method(
            &mut self,
            source: &Arc<ConnectionResource>,
            service: Arc<dyn $service>,
        ) -> Result<(), String> {
            if self.$field.is_some() {
                return Err(concat!(stringify!($field), " already has an explicit binding").into());
            }
            self.select_service(source, ServiceRole::standard(stringify!($field)))?;
            self.$field = Some(Arc::new(Bound {
                binding: Binding {
                    alive: self.source_lifetime(source)?,
                    source: source.clone(),
                    role: stringify!($field),
                },
                service,
            }));
            self.sources.insert(stringify!($field), source.clone());
            Ok(())
        }
    };
}
impl WorkspaceServices {
    pub fn new(sources: Vec<Arc<ConnectionResource>>) -> Result<Self, String> {
        let mut connections: Vec<OwnedSource> = Vec::new();
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
            connections.push(OwnedSource {
                lease: source.lease()?,
                alive: Arc::new(AtomicBool::new(true)),
            });
        }
        Ok(Self {
            alive: Arc::new(AtomicBool::new(true)),
            generations: connections
                .iter()
                .map(|owned| {
                    let identity = owned.resource().identity();
                    (identity.instance, identity.generation)
                })
                .collect(),
            connections,
            replaced: HashSet::new(),
            selected: HashMap::new(),
            sources: HashMap::new(),
            advertised: None,
            custom: Vec::new(),
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
    fn source_lifetime(&self, source: &Arc<ConnectionResource>) -> Result<Arc<AtomicBool>, String> {
        self.connections
            .iter()
            .find(|owned| Arc::ptr_eq(owned.resource(), source))
            .map(|owned| owned.alive.clone())
            .ok_or_else(|| "The selected service source is not owned by this workspace".into())
    }
    /// Validate the caller's captured identity while holding the session registry
    /// lock, before cloning a service. Legacy unpinned calls cannot follow a swap.
    pub fn check_source(
        &self,
        role: &ServiceRole,
        expected: Option<&ConnectionIdentity>,
    ) -> Result<(), String> {
        let source = self
            .selected
            .get(role)
            .ok_or("No source is selected for this service")?;
        if expected.is_some_and(|identity| identity != source.identity())
            || (expected.is_none() && self.replaced.contains(role))
        {
            return Err(
                "The selected service connection changed; use a newly accepted binding".into(),
            );
        }
        Binding {
            alive: self.source_lifetime(source)?,
            source: source.clone(),
            role: "Service",
        }
        .check()
        .map_err(|error| error.to_string())
    }
    pub fn select_service(
        &mut self,
        source: &Arc<ConnectionResource>,
        role: ServiceRole,
    ) -> Result<(), String> {
        self.source_lifetime(source)?;
        if self
            .selected
            .get(&role)
            .is_some_and(|old| !Arc::ptr_eq(old, source))
        {
            return Err("Service family already has an explicit source; cross-source path mapping is unavailable".into());
        }
        if let ServiceRole::Custom(id) = &role {
            if !custom_service_id(id) {
                return Err("Invalid custom service role".into());
            }
        }
        self.selected.insert(role, source.clone());
        Ok(())
    }
    /// Commit a fully prepared source without awaiting or changing unrelated handles.
    /// The caller closes the returned lease outside its registry lock. A cleanup
    /// failure occurs after commit and must not be treated as a failed replacement.
    /// IPC callers must capture/validate source generations before using this API.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "Desktop replacement must first coordinate app acceptance"
        )
    )]
    pub fn replace_source(
        &mut self,
        expected: &ConnectionIdentity,
        mut replacement: Self,
    ) -> Result<ConnectionLease, String> {
        if !self.alive.load(Ordering::Acquire) {
            return Err("The workspace is closed".into());
        }
        let index = self
            .connections
            .iter()
            .position(|owned| owned.resource().identity() == expected)
            .ok_or("The selected connection changed before replacement")?;
        if replacement.connections.len() != 1 || !replacement.is_connected() {
            return Err("Replacement requires exactly one connected source".into());
        }
        let old = self.connections[index].resource().clone();
        let fresh = replacement.connections[0].resource().clone();
        let identity = fresh.identity();
        if self
            .generations
            .get(&identity.instance)
            .is_some_and(|last| identity.generation <= *last)
            || self.connections.iter().enumerate().any(|(i, owned)| {
                i != index && owned.resource().identity().instance == identity.instance
            })
        {
            return Err("Replacement requires a fresh, non-conflicting connection identity".into());
        }
        let roles: HashSet<_> = self
            .selected
            .iter()
            .filter(|(_, resource)| Arc::ptr_eq(resource, &old))
            .map(|(role, _)| role.clone())
            .collect();
        if roles.is_empty() || roles != replacement.selected.keys().cloned().collect() {
            return Err("Replacement must preserve the selected service families".into());
        }
        let incoming_methods = replacement.custom_methods();
        if self
            .custom
            .iter()
            .filter(|binding| !Arc::ptr_eq(binding.source(), &old))
            .flat_map(|binding| binding.methods())
            .any(|method| {
                incoming_methods
                    .iter()
                    .any(|incoming| incoming.name == method.name)
            })
        {
            return Err("Replacement custom methods conflict with another source".into());
        }
        // Preserve discovery restrictions on unaffected sources. Recompute only
        // the replaced families, allowing their actual capabilities to change.
        let mut capabilities: HashSet<String> = self
            .status()
            .services
            .into_iter()
            .filter(|status| {
                status.state != "unsupported"
                    && !roles.contains(&ServiceRole::standard(match status.capability {
                        "terminal" => "terminal",
                        "host.settings" => "settings",
                        _ => "files",
                    }))
            })
            .map(|status| status.capability.into())
            .collect();
        capabilities.extend(
            replacement
                .status()
                .services
                .into_iter()
                .filter(|status| status.state != "unsupported")
                .map(|status| status.capability.to_string()),
        );

        // All validation precedes this point. Source-local lifetimes move with
        // the prepared services; dropping the empty candidate cannot retire them.
        let incoming = replacement
            .connections
            .pop()
            .expect("validated source count");
        let retired = std::mem::replace(&mut self.connections[index], incoming);
        retired.alive.store(false, Ordering::Release);
        self.generations
            .insert(identity.instance, identity.generation);
        if roles.contains(&ServiceRole::Files) {
            self.files = replacement.files.take();
            self.text = replacement.text.take();
            self.mutations = replacement.mutations.take();
            self.moves = replacement.moves.take();
            self.transfers = replacement.transfers.take();
        }
        if roles.contains(&ServiceRole::Console) {
            self.terminal = replacement.terminal.take();
        }
        if roles.contains(&ServiceRole::HostSettings) {
            self.settings = replacement.settings.take();
        }
        self.custom
            .retain(|binding| !Arc::ptr_eq(binding.source(), &old));
        self.custom.append(&mut replacement.custom);
        self.sources
            .retain(|_, resource| !Arc::ptr_eq(resource, &old));
        self.sources.extend(replacement.sources.drain());
        for role in roles {
            self.replaced.insert(role.clone());
            self.selected.insert(role, fresh.clone());
        }
        self.advertised = Some(capabilities);
        Ok(retired.lease)
    }
    pub fn bind_custom(
        &mut self,
        source: &Arc<ConnectionResource>,
        service: Arc<dyn CustomService>,
    ) -> Result<(), String> {
        let binding = crate::custom_binding::CustomBinding::new(
            self.source_lifetime(source)?,
            source.clone(),
            service,
        )?;
        let methods = binding.methods();
        if self.custom_methods().iter().any(|old| {
            methods
                .iter()
                .any(|new| new.service == old.service || new.name == old.name)
        }) {
            return Err("Custom service already has an explicit binding".into());
        }
        self.select_service(source, ServiceRole::Custom(methods[0].service.clone()))?;
        self.custom.push(Arc::new(binding));
        Ok(())
    }
    pub fn custom_methods(&self) -> Vec<crate::custom_binding::CustomMethodInfo> {
        self.custom
            .iter()
            .flat_map(|binding| binding.methods())
            .collect()
    }
    pub fn custom_sources(&self) -> std::collections::BTreeMap<String, ConnectionIdentity> {
        self.selected
            .iter()
            .filter_map(|(role, source)| match role {
                ServiceRole::Custom(id) => Some((id.clone(), source.identity().clone())),
                _ => None,
            })
            .collect()
    }
    pub fn custom_method(
        &self,
        method: &str,
        binding: &str,
    ) -> Option<Arc<crate::custom_binding::CustomBinding>> {
        self.custom
            .iter()
            .find(|item| item.owns(method, binding))
            .cloned()
    }
    pub fn status(&self) -> WorkspaceStatus {
        let services = [
            ("terminal", "terminal"),
            ("files.read", "files"),
            ("files.edit", "text"),
            ("files.create", "text"),
            ("files.manage", "mutations"),
            ("files.move", "moves"),
            ("files.upload", "transfers"),
            ("files.download", "transfers"),
            ("files.copy", "transfers"),
            ("files.folders", "transfers"),
            ("host.settings", "settings"),
        ]
        .into_iter()
        .map(|(capability, role)| {
            let source = self.sources.get(role);
            let supported = source.is_some()
                && (capability != "files.folders"
                    || self
                        .transfers
                        .as_ref()
                        .is_some_and(|service| service.supports_folders()))
                && self
                    .advertised
                    .as_ref()
                    .is_none_or(|caps| caps.contains(capability));
            let available = self.alive.load(Ordering::Acquire)
                && source.is_some_and(|source| source.is_connected());
            ServiceStatus {
                capability,
                state: if !supported {
                    "unsupported"
                } else if available {
                    "available"
                } else {
                    "disconnected"
                },
                reason: if !supported {
                    Some("This capability is not provided by the selected service".into())
                } else if !available {
                    Some("The connection providing this service is closed".into())
                } else {
                    None
                },
                source: source
                    .or_else(|| self.selected.get(&ServiceRole::standard(role)))
                    .map(|source| source.identity().clone()),
            }
        })
        .collect();
        WorkspaceStatus {
            connected: self.is_connected(),
            services,
            custom_sources: self.custom_sources(),
        }
    }
    /// Discovery can narrow an interface's operation support (for example,
    /// reading/creating text without atomic replacement). This advertisement
    /// does not replace the provider's operation-level validation.
    pub fn advertise_capabilities(&mut self, capabilities: &[String]) {
        self.advertised = Some(capabilities.iter().cloned().collect());
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
        for owned in self.connections.drain(..) {
            owned.alive.store(false, Ordering::Release);
            tasks.spawn(owned.lease.close());
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
    bind_role!(bind_terminal, terminal, TerminalService);
    bind_role!(bind_files, files, FileSystemProvider);
    bind_role!(bind_text, text, TextFileService);
    bind_role!(bind_mutations, mutations, FileMutationService);
    bind_role!(bind_moves, moves, FileMoveService);
    bind_role!(bind_transfers, transfers, FileTransferService);
    bind_role!(bind_settings, settings, HostSettingsService);
}
impl Drop for WorkspaceServices {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        for owned in &self.connections {
            owned.alive.store(false, Ordering::Release);
        }
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
    async fn transfer_entry(self: Arc<Self>, path: &str, revision: &str) -> Result<FileEntry> {
        self.binding
            .run(false, self.service.clone().transfer_entry(path, revision))
            .await
    }
    fn supports_folders(&self) -> bool {
        self.service.supports_folders()
    }
    async fn transfer_directory(
        self: Arc<Self>,
        path: &str,
        revision: &str,
    ) -> Result<Box<dyn TransferDirectory>> {
        self.binding.check()?;
        let mut inner = self
            .service
            .clone()
            .transfer_directory(path, revision)
            .await?;
        if let Err(error) = self.binding.after(false) {
            let _ = tokio::time::timeout(Duration::from_secs(3), inner.abort()).await;
            return Err(error);
        }
        Ok(Box::new(BoundDirectory {
            binding: self.binding.clone(),
            inner,
        }))
    }
    async fn transfer_mkdir(&self, parent: &str, name: &str) -> Result<FileLocation> {
        self.binding
            .run(true, self.service.transfer_mkdir(parent, name))
            .await
    }
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

struct BoundDirectory {
    binding: Binding,
    inner: Box<dyn TransferDirectory>,
}
#[async_trait]
impl TransferDirectory for BoundDirectory {
    async fn next(&mut self) -> Result<Vec<FileEntry>> {
        self.binding.run(false, self.inner.next()).await
    }
    async fn finish(&mut self) -> Result<()> {
        self.binding.run(false, self.inner.finish()).await
    }
    async fn abort(&mut self) -> Result<()> {
        self.inner.abort().await
    }
}
