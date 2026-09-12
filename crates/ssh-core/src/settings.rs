// SPDX-License-Identifier: MPL-2.0
//! Linux/systemd settings. No command strings or Linux assumptions escape this provider.
use crate::{Connection, HostSetting, HostSettingsService, SettingEditor};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio::sync::Mutex;

const HOSTNAME: &str = "linux.hostname";
const TIMEZONE: &str = "linux.timezone";
const READ_HOSTNAME: &str =
    "LC_ALL=C SYSTEMD_PAGER=cat SYSTEMD_COLORS=0 hostnamectl --static --no-ask-password";
const READ_TIMEZONE: &str = "LC_ALL=C SYSTEMD_PAGER=cat SYSTEMD_COLORS=0 timedatectl --no-ask-password show --property=Timezone --value";
const READ_ZONES: &str =
    "LC_ALL=C SYSTEMD_PAGER=cat SYSTEMD_COLORS=0 timedatectl --no-ask-password list-timezones";

/// Internal trusted-provider seam for controlled command fixtures; not a frontend API.
#[async_trait]
pub trait SettingsCommands: Send + Sync {
    async fn run(&self, command: &str) -> Result<String>;
}
#[async_trait]
impl SettingsCommands for Connection {
    async fn run(&self, command: &str) -> Result<String> {
        self.exec_bounded(command).await
    }
}

pub struct LinuxSettings {
    commands: Arc<dyn SettingsCommands>,
    changes: Mutex<()>,
}
impl LinuxSettings {
    pub fn new(commands: Arc<dyn SettingsCommands>) -> Self {
        Self {
            commands,
            changes: Mutex::new(()),
        }
    }
    async fn field(&self, id: &str, root: bool) -> HostSetting {
        let (label, description, editor, command) = if id == HOSTNAME {
            ("Static hostname", "The persistent name used by this Linux system. DNS records, /etc/hosts and saved connection addresses are managed separately.", SettingEditor::Text, READ_HOSTNAME)
        } else {
            ("Timezone", "The host's timezone affects local timestamps and scheduled jobs. The desktop clock picks up this timezone at its next remote refresh.", SettingEditor::Select, READ_TIMEZONE)
        };
        let mut field = HostSetting {
            id: id.into(),
            label: label.into(),
            description: description.into(),
            value: None,
            revision: None,
            editor,
            choices: vec![],
            writable: false,
            reason: None,
        };
        let result: Result<String> = async {
            let value = self.commands.run(command).await?;
            if value.len() > 256 || value.chars().any(char::is_control) {
                bail!("The host returned an invalid setting value");
            }
            Ok(value)
        }
        .await;
        match result {
            Ok(value) => {
                field.revision = Some(revision(id, &value));
                field.value = Some(value);
                field.writable = root;
                if !root {
                    field.reason = Some("Read only for this account. This provider currently supports changes through a root connection, without sudo or password prompts.".into());
                }
                if id == TIMEZONE {
                    match self.commands.run(READ_ZONES).await {
                        Ok(zones) => {
                            field.choices = zones
                                .lines()
                                .filter(|s| valid_zone(s))
                                .take(2048)
                                .map(String::from)
                                .collect();
                            field.choices.sort();
                            field.choices.dedup();
                            if field.choices.is_empty() {
                                field.writable = false;
                                field.reason =
                                    Some("The host did not provide supported timezones.".into());
                            }
                        }
                        Err(_) => {
                            field.writable = false;
                            field.reason = Some(
                                "The timezone can be read, but supported choices are unavailable."
                                    .into(),
                            );
                        }
                    }
                }
            }
            Err(error) => {
                field.reason = Some(format!(
                    "Unavailable: the systemd setting could not be read. {error:#}"
                ))
            }
        }
        field
    }
}
fn revision(id: &str, value: &str) -> String {
    format!("{:x}", Sha256::digest(format!("{id}\0{value}")))
}
fn valid_hostname(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}
fn valid_zone(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.starts_with('-')
        && value.split('/').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'+')
        })
}
#[async_trait]
impl HostSettingsService for LinuxSettings {
    async fn read(&self) -> Result<Vec<HostSetting>> {
        let root = self.commands.run("id -u").await.is_ok_and(|id| id == "0");
        let (hostname, timezone) =
            tokio::join!(self.field(HOSTNAME, root), self.field(TIMEZONE, root));
        Ok(vec![hostname, timezone])
    }
    async fn apply(&self, id: &str, value: &str, expected: &str) -> Result<HostSetting> {
        // Validate before issuing even read probes. Values cannot become shell syntax or options.
        match id {
            HOSTNAME if !valid_hostname(value) => bail!("Use a lowercase hostname with letters, digits, dots and hyphens, up to 64 characters; labels cannot start or end with a hyphen."),
            TIMEZONE if !valid_zone(value) => bail!("Choose a timezone reported by this host."),
            HOSTNAME | TIMEZONE => {},
            _ => bail!("This provider does not support that setting"),
        }
        let _guard = self.changes.lock().await;
        let root = self.commands.run("id -u").await.is_ok_and(|id| id == "0");
        let current = self.field(id, root).await;
        if !current.writable {
            bail!(
                "{}",
                current
                    .reason
                    .as_deref()
                    .unwrap_or("This setting is read only")
            );
        }
        if current.revision.as_deref() != Some(expected) {
            bail!("This setting changed on the host. Refresh and review your change again.");
        }
        if id == TIMEZONE && !current.choices.iter().any(|zone| zone == value) {
            bail!("Choose a timezone reported by this host.");
        }
        if current.value.as_deref() == Some(value) {
            return Ok(current);
        }
        let command = if id == HOSTNAME {
            format!("LC_ALL=C SYSTEMD_PAGER=cat SYSTEMD_COLORS=0 hostnamectl --static --no-ask-password set-hostname '{value}'")
        } else {
            format!("LC_ALL=C SYSTEMD_PAGER=cat SYSTEMD_COLORS=0 timedatectl --no-ask-password set-timezone '{value}'")
        };
        self.commands.run(&command).await.context("The change was not confirmed. Refresh the setting before retrying; the host may already have applied it")?;
        let verified = self.field(id, root).await;
        if verified.value.as_deref() != Some(value) {
            bail!("The command finished, but the requested value could not be verified. Refresh before retrying.");
        }
        Ok(verified)
    }
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
