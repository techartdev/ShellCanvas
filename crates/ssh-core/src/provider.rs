// SPDX-License-Identifier: MPL-2.0
use crate::{
    Connection, Directory, FileEntry, FileLocation, FilePlace, FileSystemProvider, ProbeContext,
    OP_TIMEOUT,
};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::sync::Arc;
use tokio::{io::AsyncReadExt, time::timeout};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub provider: String,
    pub system: String,
    pub hostname: String,
    pub home: Option<String>,
    pub capabilities: Vec<String>,
    pub notices: Vec<String>,
}

#[async_trait]
pub trait SystemProvider: Send + Sync {
    fn id(&self) -> &'static str;
    async fn detect(&self, context: &ProbeContext<'_>) -> bool;
    async fn inspect(&self, context: &ProbeContext<'_>) -> Result<HostInfo>;
    fn settings(
        &self,
        _commands: Option<Arc<dyn crate::settings::SettingsCommands>>,
    ) -> Option<Arc<dyn crate::HostSettingsService>> {
        None
    }
}

pub struct LinuxProvider;
#[async_trait]
impl SystemProvider for LinuxProvider {
    fn id(&self) -> &'static str {
        "linux"
    }
    fn settings(
        &self,
        commands: Option<Arc<dyn crate::settings::SettingsCommands>>,
    ) -> Option<Arc<dyn crate::HostSettingsService>> {
        commands.map(|commands| {
            Arc::new(crate::settings::LinuxSettings::new(commands))
                as Arc<dyn crate::HostSettingsService>
        })
    }
    async fn detect(&self, context: &ProbeContext<'_>) -> bool {
        let Some(commands) = context.commands else {
            return false;
        };
        commands.probe("uname -s").await.is_ok_and(|s| s == "Linux")
    }
    async fn inspect(&self, context: &ProbeContext<'_>) -> Result<HostInfo> {
        let commands = context
            .commands
            .context("System inspection needs independent command probes")?;
        let hostname = commands
            .probe("uname -n")
            .await
            .unwrap_or_else(|_| "Linux host".into());
        let system = commands
            .probe("uname -sr")
            .await
            .unwrap_or_else(|_| "Linux".into());
        let mut info = context.fallback.clone();
        info.provider = self.id().into();
        info.hostname = hostname;
        info.system = system;
        Ok(info)
    }
}

static SYSTEM_PROVIDERS: &[&dyn SystemProvider] = &[&LinuxProvider];

pub fn settings_for_host(
    provider: &str,
    commands: Option<Arc<dyn crate::settings::SettingsCommands>>,
) -> Option<Arc<dyn crate::HostSettingsService>> {
    SYSTEM_PROVIDERS
        .iter()
        .find(|candidate| candidate.id() == provider)
        .and_then(|provider| provider.settings(commands))
}

pub async fn inspect_host(connection: &Connection) -> HostInfo {
    let fallback = HostInfo {
        provider: "generic-ssh".into(),
        system: "Generic SSH".into(),
        hostname: "SSH host".into(),
        home: None,
        capabilities: vec!["terminal".into()],
        notices: vec![],
    };
    inspect_with_providers(
        &ProbeContext {
            commands: Some(connection),
            fallback,
        },
        SYSTEM_PROVIDERS,
        OP_TIMEOUT,
    )
    .await
}

/// Ordered trusted providers share a total detection budget. Unrecognized or
/// failed detection preserves only the services supplied by the connection.
pub async fn inspect_with_providers(
    context: &ProbeContext<'_>,
    providers: &[&dyn SystemProvider],
    budget: std::time::Duration,
) -> HostInfo {
    let selected = timeout(budget, async {
        for provider in providers {
            if provider.detect(context).await {
                if let Ok(info) = provider.inspect(context).await {
                    return Some(info);
                }
            }
        }
        None
    })
    .await;
    match selected {
        Ok(Some(info)) => info,
        outcome => {
            let mut info = context.fallback.clone();
            info.notices.push(if outcome.is_err() {
                "Device detection timed out. Available connection tools can still be used."
            } else {
                "No supported device provider detected. Available connection tools can still be used."
            }.into());
            info
        }
    }
}

pub struct SftpFileSystem(pub SftpSession);

// POSIX SFTP conventions belong to this adapter, never the desktop apps.
pub(crate) fn sftp_location(path: String) -> FileLocation {
    let trimmed = path.trim_end_matches('/');
    let (parent, name) = trimmed.rsplit_once('/').unwrap_or(("", trimmed));
    FileLocation {
        name: if trimmed.is_empty() {
            "Filesystem".into()
        } else {
            name.into()
        },
        parent: if trimmed.is_empty() {
            None
        } else {
            Some(if parent.is_empty() {
                "/".into()
            } else {
                parent.into()
            })
        },
        path,
    }
}

#[async_trait]
impl FileSystemProvider for SftpFileSystem {
    async fn list(&self, path: Option<&str>) -> Result<Directory> {
        timeout(OP_TIMEOUT, async {
            let path = self.0.canonicalize(path.unwrap_or(".")).await?;
            let mut entries = Vec::new();
            for entry in self.0.read_dir(&path).await? {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let metadata = entry.metadata();
                let kind = if metadata.is_dir() {
                    "directory"
                } else if metadata.is_symlink() {
                    "symlink"
                } else {
                    "file"
                };
                entries.push(FileEntry {
                    path: format!("{}/{name}", path.trim_end_matches('/')),
                    name,
                    kind: kind.into(),
                    size: metadata.size.unwrap_or(0),
                    modified: metadata.mtime,
                    revision: crate::entry_revision(&metadata),
                });
            }
            entries.sort_by(|a, b| {
                (a.kind != "directory", a.name.to_lowercase())
                    .cmp(&(b.kind != "directory", b.name.to_lowercase()))
            });
            let location = sftp_location(path);
            let home = self.0.canonicalize(".").await.ok().map(|path| FilePlace {
                path,
                name: "Home".into(),
            });
            let roots = self
                .0
                .canonicalize("/")
                .await
                .ok()
                .map(|path| FilePlace {
                    path,
                    name: "Filesystem".into(),
                })
                .into_iter()
                .collect();
            Ok(Directory {
                path: location.path,
                name: location.name,
                parent: location.parent,
                home,
                roots,
                entries,
            })
        })
        .await
        .context("Directory listing timed out")?
    }
    async fn locate(&self, path: &str) -> Result<FileLocation> {
        timeout(OP_TIMEOUT, async {
            Ok(sftp_location(self.0.canonicalize(path).await?))
        })
        .await
        .context("File location lookup timed out")?
    }
    async fn preview(&self, path: &str) -> Result<String> {
        timeout(OP_TIMEOUT, async {
            // Check before opening: never read FIFOs, devices, or arbitrarily large files.
            let metadata = self.0.metadata(path).await?;
            if !metadata.is_regular() {
                bail!("Preview supports regular text files only.");
            }
            if metadata.size.is_some_and(|size| size > 256 * 1024) {
                bail!("Preview is limited to 256 KiB.");
            }
            let file = self.0.open(path).await?;
            let mut bytes = Vec::new();
            file.take(256 * 1024 + 1).read_to_end(&mut bytes).await?;
            if bytes.len() > 256 * 1024 {
                bail!("Preview is limited to 256 KiB.");
            }
            if bytes.contains(&0) {
                bail!("This appears to be a binary file.");
            }
            String::from_utf8(bytes).context("This file is not UTF-8 text.")
        })
        .await
        .context("File preview timed out")?
    }
}

#[cfg(test)]
mod detection_tests {
    use super::*;
    use crate::CommandProbe;
    use std::time::Duration;

    fn fallback(capabilities: &[&str]) -> HostInfo {
        HostInfo {
            provider: "generic-device".into(),
            system: "Device".into(),
            hostname: "Fixture".into(),
            home: None,
            capabilities: capabilities.iter().map(|s| (*s).into()).collect(),
            notices: vec![],
        }
    }

    struct LinuxCommands;
    #[async_trait]
    impl CommandProbe for LinuxCommands {
        async fn probe(&self, command: &str) -> Result<String> {
            Ok(match command {
                "uname -s" => "Linux",
                "uname -n" => "fixture-linux",
                "uname -sr" => "Linux fixture-kernel",
                _ => bail!("Unexpected probe"),
            }
            .into())
        }
    }

    #[tokio::test]
    async fn linux_detection_uses_injected_service_without_inventing_terminal_support() {
        let context = ProbeContext {
            commands: Some(&LinuxCommands),
            fallback: fallback(&["files.read"]),
        };
        let info = inspect_with_providers(&context, &[&LinuxProvider], OP_TIMEOUT).await;
        assert_eq!(info.provider, "linux");
        assert_eq!(info.hostname, "fixture-linux");
        assert_eq!(info.capabilities, vec!["files.read"]);
        assert!(info.notices.is_empty());
    }

    #[tokio::test]
    async fn limited_connections_do_not_require_exec_or_claim_extra_services() {
        for capabilities in [vec!["terminal"], vec!["files.read"], vec![]] {
            let context = ProbeContext {
                commands: None,
                fallback: fallback(&capabilities),
            };
            let info = inspect_with_providers(&context, &[&LinuxProvider], OP_TIMEOUT).await;
            assert_eq!(info.provider, "generic-device");
            assert_eq!(info.capabilities, capabilities);
            assert!(!info.notices.is_empty());
        }
    }

    struct FailedCommands;
    #[async_trait]
    impl CommandProbe for FailedCommands {
        async fn probe(&self, _: &str) -> Result<String> {
            bail!("Exec unsupported")
        }
    }
    #[tokio::test]
    async fn failed_exec_keeps_existing_services() {
        let context = ProbeContext {
            commands: Some(&FailedCommands),
            fallback: fallback(&["terminal"]),
        };
        let info = inspect_with_providers(&context, &[&LinuxProvider], OP_TIMEOUT).await;
        assert_eq!(info.provider, "generic-device");
        assert_eq!(info.capabilities, vec!["terminal"]);
    }

    struct HangingCommands;
    #[async_trait]
    impl CommandProbe for HangingCommands {
        async fn probe(&self, _: &str) -> Result<String> {
            std::future::pending().await
        }
    }
    #[tokio::test]
    async fn detection_budget_preserves_access_after_a_hung_probe() {
        let context = ProbeContext {
            commands: Some(&HangingCommands),
            fallback: fallback(&["files.read"]),
        };
        let info =
            inspect_with_providers(&context, &[&LinuxProvider], Duration::from_millis(1)).await;
        assert_eq!(info.capabilities, vec!["files.read"]);
        assert!(info.notices[0].contains("timed out"));
    }
}
