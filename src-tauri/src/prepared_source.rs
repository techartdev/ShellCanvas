// SPDX-License-Identifier: MPL-2.0
//! A prepared connection owns its lifetime before it is assigned to a workspace.
use crate::{
    connection_resource::{ConnectionLease, ConnectionResource},
    workspace_services::{ServiceRole, WorkspaceServices},
};
use shellcanvas_adapter_runtime::AdapterProcess;
use shellcanvas_services::*;
use std::{collections::HashMap, sync::Arc};

pub struct PreparedSource {
    pub resource: Arc<ConnectionResource>,
    _lease: ConnectionLease,
    pub info: HostInfo,
    pub terminal: Option<Arc<dyn TerminalService>>,
    pub files: Option<Arc<dyn FileSystemProvider>>,
    pub text: Option<Arc<dyn TextFileService>>,
    pub mutations: Option<Arc<dyn FileMutationService>>,
    pub moves: Option<Arc<dyn FileMoveService>>,
    pub transfers: Option<Arc<dyn FileTransferService>>,
    pub settings: Option<Arc<dyn HostSettingsService>>,
    pub custom: Vec<Arc<dyn CustomService>>,
}
impl PreparedSource {
    pub fn new(resource: Arc<ConnectionResource>, info: HostInfo) -> Result<Self, String> {
        let lease = resource.lease()?;
        Ok(Self {
            resource,
            _lease: lease,
            info,
            terminal: None,
            files: None,
            text: None,
            mutations: None,
            moves: None,
            transfers: None,
            settings: None,
            custom: vec![],
        })
    }
    pub fn adapter(identity: ConnectionIdentity, process: AdapterProcess) -> Result<Self, String> {
        let mut source = Self::new(
            ConnectionResource::new(identity, Arc::new(process.clone())),
            HostInfo {
                provider: "adapters".into(),
                system: "Adapter workspace".into(),
                hostname: String::new(),
                home: None,
                capabilities: vec![],
                notices: vec![],
            },
        )?;
        source.files = process.files();
        source.terminal = process.terminal();
        source.settings = process.settings();
        if source.files.is_some() {
            source.info.capabilities.push("files.read".into());
            source.text = process.text();
            source.mutations = process.mutations();
            source.moves = process.moves();
            source.transfers = process.transfers();
            for (capability, available) in [
                (
                    "files.create",
                    source.text.is_some() && process.supports("files", 1, &["files.createText"]),
                ),
                (
                    "files.edit",
                    source.text.is_some() && process.supports("files", 1, &["files.saveText"]),
                ),
                ("files.manage", source.mutations.is_some()),
                ("files.move", source.moves.is_some()),
                ("files.download", process.downloads_supported()),
                ("files.upload", process.uploads_supported()),
                (
                    "files.copy",
                    process.downloads_supported() && process.uploads_supported(),
                ),
                (
                    "files.folders",
                    source
                        .transfers
                        .as_ref()
                        .is_some_and(|service| service.supports_folders()),
                ),
            ] {
                if available {
                    source.info.capabilities.push(capability.into());
                }
            }
        }
        if source.terminal.is_some() {
            source.info.capabilities.push("terminal".into());
        }
        if source.settings.is_some() {
            source.info.capabilities.push("host.settings".into());
        }
        source.custom = process
            .services()
            .iter()
            .filter_map(|service| process.custom(&service.id))
            .collect();
        Ok(source)
    }
    fn bind(&self, role: &str, workspace: &mut WorkspaceServices) -> Result<(), String> {
        let resource = &self.resource;
        match role {
            "files" => {
                workspace.select_service(resource, ServiceRole::Files)?;
                if let Some(service) = &self.files {
                    workspace.bind_files(resource, service.clone())?;
                }
                if let Some(service) = &self.text {
                    workspace.bind_text(resource, service.clone())?;
                }
                if let Some(service) = &self.mutations {
                    workspace.bind_mutations(resource, service.clone())?;
                }
                if let Some(service) = &self.moves {
                    workspace.bind_moves(resource, service.clone())?;
                }
                if let Some(service) = &self.transfers {
                    workspace.bind_transfers(resource, service.clone())?;
                }
            }
            "console" => {
                workspace.select_service(resource, ServiceRole::Console)?;
                if let Some(service) = &self.terminal {
                    workspace.bind_terminal(resource, service.clone())?;
                }
            }
            "host.settings" => {
                workspace.select_service(resource, ServiceRole::HostSettings)?;
                if let Some(service) = &self.settings {
                    workspace.bind_settings(resource, service.clone())?;
                }
            }
            custom => workspace.bind_custom(
                resource,
                self.custom
                    .iter()
                    .find(|service| service.descriptor().id == custom)
                    .ok_or_else(|| {
                        format!("The selected connection does not advertise service {custom}")
                    })?
                    .clone(),
            )?,
        }
        Ok(())
    }
}
pub fn compose(
    sources: Vec<(String, PreparedSource)>,
    bindings: &HashMap<String, String>,
    name: String,
) -> Result<(WorkspaceServices, HostInfo), String> {
    if sources.is_empty() || bindings.is_empty() {
        return Err("Choose a connection and its services".into());
    }
    let keys: std::collections::HashSet<_> = sources.iter().map(|(key, _)| key).collect();
    if keys.len() != sources.len()
        || sources
            .iter()
            .any(|(key, _)| !bindings.values().any(|value| value == key))
    {
        return Err(
            "Each prepared source needs a unique key and explicit service assignment".into(),
        );
    }
    let mut workspace = WorkspaceServices::new(
        sources
            .iter()
            .map(|(_, source)| source.resource.clone())
            .collect(),
    )?;
    let mut capabilities = vec![];
    for (role, key) in bindings {
        let source = &sources
            .iter()
            .find(|(candidate, _)| candidate == key)
            .ok_or("Missing connection source")?
            .1;
        source.bind(role, &mut workspace)?;
        capabilities.extend(
            source
                .info
                .capabilities
                .iter()
                .filter(|capability| match role.as_str() {
                    "files" => capability.starts_with("files."),
                    "console" => *capability == "terminal",
                    "host.settings" => *capability == "host.settings",
                    _ => false,
                })
                .cloned(),
        );
    }
    workspace.advertise_capabilities(&capabilities);
    let mut notices: Vec<String> = sources
        .iter()
        .flat_map(|(_, source)| source.info.notices.clone())
        .collect();
    for (role, capability) in [
        ("files", "files.read"),
        ("console", "terminal"),
        ("host.settings", "host.settings"),
    ] {
        if bindings.contains_key(role) && !capabilities.iter().any(|value| value == capability) {
            notices.push(format!(
                "{} is unavailable through its selected connection.",
                capability
            ));
        }
    }
    Ok((
        workspace,
        HostInfo {
            provider: "adapters".into(),
            system: "Adapter workspace".into(),
            hostname: name,
            home: None,
            capabilities,
            notices,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    #[tokio::test]
    async fn real_ssh_console_survives_independent_file_source_replacement() {
        use russh::{server, Channel, ChannelId};
        struct Echo;
        impl server::Handler for Echo {
            type Error = russh::Error;
            async fn auth_password(
                &mut self,
                user: &str,
                password: &str,
            ) -> Result<server::Auth, Self::Error> {
                assert_eq!(user, "fixture");
                assert_eq!(password, "local-test-only");
                Ok(server::Auth::Accept)
            }
            async fn channel_open_session(
                &mut self,
                _channel: Channel<server::Msg>,
                reply: server::ChannelOpenHandle,
                _session: &mut server::Session,
            ) -> Result<(), Self::Error> {
                reply.accept().await;
                Ok(())
            }
            async fn pty_request(
                &mut self,
                channel: ChannelId,
                _: &str,
                _: u32,
                _: u32,
                _: u32,
                _: u32,
                _: &[(russh::Pty, u32)],
                session: &mut server::Session,
            ) -> Result<(), Self::Error> {
                session.channel_success(channel)?;
                Ok(())
            }
            async fn shell_request(
                &mut self,
                channel: ChannelId,
                session: &mut server::Session,
            ) -> Result<(), Self::Error> {
                session.channel_success(channel)?;
                Ok(())
            }
            async fn data(
                &mut self,
                channel: ChannelId,
                data: &[u8],
                session: &mut server::Session,
            ) -> Result<(), Self::Error> {
                session.data(channel, data.to_vec())?;
                Ok(())
            }
        }
        let key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let dir = tempfile::tempdir().unwrap();
        let trust = dir.path().join("known_hosts");
        std::fs::write(
            &trust,
            format!(
                "[127.0.0.1]:{port} {}\n",
                key.public_key().to_openssh().unwrap()
            ),
        )
        .unwrap();
        let config = Arc::new(server::Config {
            keys: vec![key],
            auth_rejection_time: std::time::Duration::ZERO,
            inactivity_timeout: Some(std::time::Duration::from_secs(10)),
            ..Default::default()
        });
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let session = server::run_stream(config, stream, Echo).await.unwrap();
            let _ = session.await;
        });
        let connection = Arc::new(
            shellcanvas_core::Connection::connect_with_trust_store(
                &shellcanvas_core::ConnectOptions {
                    host: "127.0.0.1".into(),
                    port,
                    username: "fixture".into(),
                    key_path: String::new(),
                    password: Some("local-test-only".into()),
                    allow_legacy_mac: false,
                    passphrase: None,
                },
                trust,
            )
            .await
            .unwrap(),
        );
        let resource = ConnectionResource::new(
            ConnectionIdentity {
                instance: 80,
                generation: 1,
                adapter: "ssh".into(),
            },
            connection.clone(),
        );
        let mut ssh = PreparedSource::new(
            resource.clone(),
            HostInfo {
                provider: "unknown".into(),
                system: "fixture".into(),
                hostname: "loopback".into(),
                home: None,
                capabilities: vec!["terminal".into()],
                notices: vec![],
            },
        )
        .unwrap();
        ssh.terminal = Some(connection.clone());
        let (mut files, old_life) = source(81, "fixture.files");
        let old_identity = files.resource.identity().clone();
        files.files = Some(Arc::new(Files("old files")));
        files.info.capabilities = vec!["files.read".into()];
        let (mut workspace, _) = compose(
            vec![("ssh".into(), ssh), ("files".into(), files)],
            &[
                ("console".into(), "ssh".into()),
                ("files".into(), "files".into()),
            ]
            .into(),
            "mixed".into(),
        )
        .unwrap();
        let mut console = workspace
            .terminal
            .as_ref()
            .unwrap()
            .open(TerminalSize::new(80, 24))
            .await
            .unwrap();
        let old_files = workspace.files.as_ref().unwrap().clone();
        let (mut next, _) = source(82, "fixture.next");
        next.files = Some(Arc::new(Files("new files")));
        next.info.capabilities = vec!["files.read".into()];
        let (candidate, _) = compose(
            vec![("files".into(), next)],
            &[("files".into(), "files".into())].into(),
            "candidate".into(),
        )
        .unwrap();
        workspace
            .replace_source(&old_identity, candidate)
            .unwrap()
            .close()
            .await
            .unwrap();
        assert_eq!(old_life.closed.load(Ordering::Acquire), 1);
        assert!(old_files.preview("opaque").await.is_err());
        assert_eq!(
            workspace
                .files
                .as_ref()
                .unwrap()
                .preview("opaque")
                .await
                .unwrap(),
            "new files"
        );
        console.writer.write(&[0, 255, 17, 42]).await.unwrap();
        let bytes = tokio::time::timeout(std::time::Duration::from_secs(3), console.reader.read())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(bytes, vec![0, 255, 17, 42]);
        assert!(connection.is_connected());
        console.writer.close().await.unwrap();
        drop(workspace);
        resource.disconnect().await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(3), server)
            .await
            .unwrap()
            .unwrap();
    }
    struct Lifecycle {
        alive: AtomicBool,
        closed: AtomicUsize,
    }
    #[async_trait]
    impl ConnectionLifecycle for Lifecycle {
        fn is_connected(&self) -> bool {
            self.alive.load(Ordering::Acquire)
        }
        async fn disconnect(&self) -> anyhow::Result<()> {
            self.alive.store(false, Ordering::Release);
            self.closed.fetch_add(1, Ordering::AcqRel);
            Ok(())
        }
    }
    struct Files(&'static str);
    #[async_trait]
    impl FileSystemProvider for Files {
        async fn list(&self, _: Option<&str>) -> anyhow::Result<Directory> {
            anyhow::bail!("Unused")
        }
        async fn locate(&self, path: &str) -> anyhow::Result<FileLocation> {
            Ok(FileLocation {
                path: path.into(),
                name: self.0.into(),
                parent: None,
            })
        }
        async fn preview(&self, _: &str) -> anyhow::Result<String> {
            Ok(self.0.into())
        }
    }
    fn source(id: u64, adapter: &str) -> (PreparedSource, Arc<Lifecycle>) {
        let lifecycle = Arc::new(Lifecycle {
            alive: AtomicBool::new(true),
            closed: AtomicUsize::new(0),
        });
        let resource = ConnectionResource::new(
            ConnectionIdentity {
                instance: id,
                generation: 1,
                adapter: adapter.into(),
            },
            lifecycle.clone(),
        );
        let source = PreparedSource::new(
            resource,
            HostInfo {
                provider: adapter.into(),
                system: "fixture".into(),
                hostname: "fixture".into(),
                home: None,
                capabilities: vec![],
                notices: vec![],
            },
        )
        .unwrap();
        (source, lifecycle)
    }
    async fn closed(lifecycle: &Lifecycle) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while lifecycle.closed.load(Ordering::Acquire) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn compose_selects_service_families_without_leaking_unused_capabilities() {
        let (mut ssh, ssh_life) = source(1, "ssh");
        ssh.files = Some(Arc::new(Files("ssh files")));
        ssh.info.capabilities = vec!["files.read".into(), "files.edit".into()];
        let (mut adapter, adapter_life) = source(2, "dev.adapter");
        adapter.files = Some(Arc::new(Files("adapter files")));
        adapter.info.capabilities = vec!["files.read".into()];
        let (workspace, info) = compose(
            vec![("ssh".into(), ssh), ("adapter".into(), adapter)],
            &[
                ("files".into(), "adapter".into()),
                ("console".into(), "ssh".into()),
            ]
            .into(),
            "mixed".into(),
        )
        .unwrap();
        assert_eq!(info.capabilities, vec!["files.read"]);
        assert!(info.notices.iter().any(|note| note.contains("terminal")));
        assert_eq!(
            workspace
                .files
                .as_ref()
                .unwrap()
                .preview("opaque")
                .await
                .unwrap(),
            "adapter files"
        );
        assert!(ssh_life.alive.load(Ordering::Acquire));
        drop(workspace);
        closed(&ssh_life).await;
        closed(&adapter_life).await;
        assert_eq!(ssh_life.closed.load(Ordering::Acquire), 1);
    }
    #[tokio::test]
    async fn discarded_or_invalid_preparation_closes_every_owned_source() {
        let (prepared, life) = source(3, "ssh");
        drop(prepared);
        closed(&life).await;
        let (first, a) = source(4, "ssh");
        let (second, b) = source(5, "dev.adapter");
        assert!(compose(
            vec![("one".into(), first), ("two".into(), second)],
            &[
                ("services.missing".into(), "one".into()),
                ("files".into(), "two".into())
            ]
            .into(),
            "invalid".into()
        )
        .is_err());
        closed(&a).await;
        closed(&b).await;
    }
}
