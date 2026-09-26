// SPDX-License-Identifier: MPL-2.0
//! Secrets for explicitly saved connections. Profile files contain public settings only.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const HOST_SERVICE: &str = "ShellCanvas.saved-hosts.v1";
const WORKSPACE_SERVICE: &str = "ShellCanvas.saved-workspaces.v1";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostSecret {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub key_path: String,
    pub allow_legacy_mac: bool,
    pub kind: String,
    pub value: String,
}
impl HostSecret {
    pub fn matches_profile(&self, profile: &shellcanvas_core::HostProfile) -> bool {
        self.host == profile.host
            && self.port == profile.port
            && self.username == profile.username
            && self.key_path == profile.key_path
            && self.allow_legacy_mac == profile.allow_legacy_mac
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSecrets {
    pub revision: String,
    pub fields: HashMap<String, HashMap<String, String>>,
}

fn entry(service: &str, id: &str) -> Result<keyring::Entry, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid saved connection ID")?;
    keyring::Entry::new(service, id).map_err(|_| "System credential store unavailable".into())
}

fn read<T: for<'de> Deserialize<'de>>(service: &str, id: &str) -> Result<Option<T>, String> {
    match entry(service, id)?.get_password() {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| "Saved credential is invalid; forget and save it again".into()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Cannot read the system credential store. Unlock it and retry".into()),
    }
}

fn write<T: Serialize>(service: &str, id: &str, secret: &T) -> Result<(), String> {
    let value = serde_json::to_string(secret).map_err(|_| "Cannot encode credential")?;
    if value.len() > 4096 {
        return Err("Saved credential exceeds the system store limit".into());
    }
    entry(service, id)?
        .set_password(&value)
        .map_err(|_| "Cannot save in the system credential store. Unlock it and retry".into())
}

fn remove(service: &str, id: &str) -> Result<(), String> {
    match entry(service, id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => {
            Err("Cannot remove the saved credential. Unlock the system store and retry".into())
        }
    }
}

pub fn host(id: &str) -> Result<Option<HostSecret>, String> {
    read(HOST_SERVICE, id)
}
pub fn save_host(id: &str, secret: &HostSecret) -> Result<(), String> {
    write(HOST_SERVICE, id, secret)
}
pub fn remove_host(id: &str) -> Result<(), String> {
    remove(HOST_SERVICE, id)
}
pub fn workspace(id: &str) -> Result<Option<WorkspaceSecrets>, String> {
    read(WORKSPACE_SERVICE, id)
}
pub fn save_workspace(id: &str, secret: &WorkspaceSecrets) -> Result<(), String> {
    write(WORKSPACE_SERVICE, id, secret)
}
pub fn remove_workspace(id: &str) -> Result<(), String> {
    remove(WORKSPACE_SERVICE, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_secret_is_bound_to_endpoint_and_authentication_settings() {
        let profile = shellcanvas_core::HostProfile {
            host: "server.example".into(),
            port: 22,
            username: "alice".into(),
            key_path: "~/.ssh/id_ed25519".into(),
            ..Default::default()
        };
        let secret = HostSecret {
            host: profile.host.clone(),
            port: profile.port,
            username: profile.username.clone(),
            key_path: profile.key_path.clone(),
            allow_legacy_mac: false,
            kind: "passphrase".into(),
            value: "secret".into(),
        };
        assert!(secret.matches_profile(&profile));
        let mut other = profile.clone();
        other.host = "other.example".into();
        assert!(!secret.matches_profile(&other));
        other = profile.clone();
        other.key_path = "~/.ssh/other".into();
        assert!(!secret.matches_profile(&other));
        other = profile;
        other.allow_legacy_mac = true;
        assert!(!secret.matches_profile(&other));
    }
}
