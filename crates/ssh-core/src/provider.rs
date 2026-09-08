// SPDX-License-Identifier: MPL-2.0
use crate::{Connection, ProbeContext, OP_TIMEOUT};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use russh_sftp::client::SftpSession;
use serde::Serialize;
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
}

pub struct LinuxProvider;
#[async_trait]
impl SystemProvider for LinuxProvider {
    fn id(&self) -> &'static str {
        "linux"
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
        &[&LinuxProvider],
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub modified: Option<u32>,
    pub revision: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Directory {
    pub path: String,
    pub entries: Vec<FileEntry>,
}

#[async_trait]
pub trait FileSystemProvider: Send + Sync {
    async fn list(&self, path: &str) -> Result<Directory>;
    async fn preview(&self, path: &str) -> Result<String>;
}

pub struct SftpFileSystem(pub SftpSession);

#[async_trait]
impl FileSystemProvider for SftpFileSystem {
    async fn list(&self, path: &str) -> Result<Directory> {
        timeout(OP_TIMEOUT, async {
            let path = self.0.canonicalize(path).await?;
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
            Ok(Directory { path, entries })
        })
        .await
        .context("Directory listing timed out")?
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
