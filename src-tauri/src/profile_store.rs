// SPDX-License-Identifier: MPL-2.0
use serde::{Deserialize, Serialize};
use shellcanvas_core::HostProfile;
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_SIZE: u64 = 2 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Store {
    version: u32,
    profiles: Vec<SavedProfile>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedProfile {
    id: String,
    name: String,
    connection: ConnectionSettings,
}
// Versioned, connector-tagged settings; secrets are intentionally not representable.
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum ConnectionSettings {
    Ssh {
        host: String,
        port: u16,
        username: String,
        #[serde(rename = "keyPath")]
        key_path: String,
        #[serde(
            rename = "allowLegacyMac",
            default,
            skip_serializing_if = "std::ops::Not::not"
        )]
        allow_legacy_mac: bool,
    },
}
impl SavedProfile {
    fn public(&self) -> HostProfile {
        let ConnectionSettings::Ssh {
            host,
            port,
            username,
            key_path,
            allow_legacy_mac,
        } = &self.connection;
        HostProfile {
            id: Some(self.id.clone()),
            name: self.name.clone(),
            host: host.clone(),
            port: *port,
            username: username.clone(),
            key_path: key_path.clone(),
            allow_legacy_mac: *allow_legacy_mac,
        }
    }
}
fn validate(profile: &HostProfile) -> Result<(), String> {
    if profile.name.trim().is_empty()
        || profile.host.trim().is_empty()
        || profile.username.trim().is_empty()
        || profile.port == 0
    {
        return Err("A name, host, username and valid port are required to save a host.".into());
    }
    if [
        &profile.name,
        &profile.host,
        &profile.username,
        &profile.key_path,
    ]
    .iter()
    .any(|s| s.len() > 4096 || s.contains(['\0', '\n', '\r']))
    {
        return Err("Host settings contain invalid or excessively long values.".into());
    }
    if profile
        .id
        .as_ref()
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
    {
        return Err("Invalid saved host ID.".into());
    }
    Ok(())
}
fn load(path: &Path) -> Result<Store, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Store {
                version: 1,
                profiles: vec![],
            })
        }
        Err(error) => return Err(format!("Cannot read saved hosts: {error}")),
    };
    let mut bytes = Vec::new();
    file.take(MAX_SIZE + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_SIZE {
        return Err("Saved host file exceeds 2 MiB.".into());
    }
    let store: Store = serde_json::from_slice(&bytes)
        .map_err(|_| "Saved host file is invalid; it was not changed.".to_string())?;
    if store.version != 1 {
        return Err(
            "Saved hosts use an unsupported storage version; the file was not changed.".into(),
        );
    }
    let mut ids = HashSet::new();
    for profile in &store.profiles {
        validate(&profile.public())?;
        if !ids.insert(&profile.id) {
            return Err("Saved hosts contain duplicate IDs.".into());
        }
    }
    Ok(store)
}
fn write(path: &Path, store: &Store) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_SIZE {
        return Err("Saved hosts exceed the storage limit.".into());
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(path.parent().ok_or("Invalid host storage path")?)
            .map_err(|e| e.to_string())?;
    temporary.write_all(&bytes).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary
        .persist(path)
        .map_err(|e| format!("Cannot save hosts: {e}"))?;
    Ok(())
}

/// Serializes read/modify/write across threads and app processes. All I/O runs
/// on Tauri's blocking pool. A failed parse/write never truncates the old file.
fn locked<T>(dir: &Path, action: impl FnOnce(&Path) -> Result<T, String>) -> Result<T, String> {
    fs::create_dir_all(dir).map_err(|e| format!("Cannot create host storage: {e}"))?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("hosts.lock"))
        .map_err(|e| e.to_string())?;
    lock.lock().map_err(|e| e.to_string())?;
    action(&dir.join("hosts.json")) // File drop releases the advisory lock.
}
pub fn list(dir: &Path) -> Result<Vec<HostProfile>, String> {
    locked(dir, |path| {
        Ok(load(path)?
            .profiles
            .iter()
            .map(SavedProfile::public)
            .collect())
    })
}
pub fn save(dir: &Path, mut profile: HostProfile) -> Result<HostProfile, String> {
    profile.name = profile.name.trim().into();
    profile.host = profile.host.trim().into();
    profile.username = profile.username.trim().into();
    profile.key_path = profile.key_path.trim().into();
    validate(&profile)?;
    locked(dir, |path| {
        let mut store = load(path)?;
        let index = if let Some(id) = &profile.id {
            Some(
                store
                    .profiles
                    .iter()
                    .position(|p| &p.id == id)
                    .ok_or("This saved host was removed. Save it as a new host.")?,
            )
        } else {
            None
        };
        let id = profile
            .id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let saved = SavedProfile {
            id: id.clone(),
            name: profile.name.clone(),
            connection: ConnectionSettings::Ssh {
                host: profile.host.clone(),
                port: profile.port,
                username: profile.username.clone(),
                key_path: profile.key_path.clone(),
                allow_legacy_mac: profile.allow_legacy_mac,
            },
        };
        if let Some(index) = index {
            store.profiles[index] = saved;
        } else {
            if store.profiles.len() >= 500 {
                return Err("The saved host limit is 500.".into());
            }
            store.profiles.push(saved);
        }
        write(path, &store)?;
        profile.id = Some(id);
        Ok(profile)
    })
}
pub fn remove(dir: &Path, id: &str) -> Result<(), String> {
    locked(dir, |path| {
        let mut store = load(path)?;
        let index = store
            .profiles
            .iter()
            .position(|p| p.id == id)
            .ok_or("This saved host no longer exists.")?;
        store.profiles.remove(index);
        write(path, &store)
    })
}
pub fn storage_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> HostProfile {
        HostProfile {
            name: "Test host".into(),
            host: "host.example".into(),
            username: "tester".into(),
            port: 22,
            ..Default::default()
        }
    }
    #[test]
    fn legacy_mac_defaults_off_and_survives_save_and_disable() {
        let dir = tempfile::tempdir().unwrap();
        let mut saved = save(dir.path(), profile()).unwrap();
        assert!(!saved.allow_legacy_mac);
        let path = dir.path().join("hosts.json");
        assert!(!fs::read_to_string(&path)
            .unwrap()
            .contains("allowLegacyMac"));
        assert!(!list(dir.path()).unwrap()[0].allow_legacy_mac);
        saved.allow_legacy_mac = true;
        save(dir.path(), saved.clone()).unwrap();
        assert!(list(dir.path()).unwrap()[0].allow_legacy_mac);
        saved.allow_legacy_mac = false;
        save(dir.path(), saved).unwrap();
        assert!(!list(dir.path()).unwrap()[0].allow_legacy_mac);
    }
    #[test]
    fn persists_edits_and_removal_across_reads_with_connector_tag() {
        let dir = tempfile::tempdir().unwrap();
        let mut saved = save(dir.path(), profile()).unwrap();
        let id = saved.id.clone();
        saved.name = "Renamed host".into();
        save(dir.path(), saved).unwrap();
        let loaded = list(dir.path()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "Renamed host");
        assert_eq!(loaded[0].id, id);
        let text = fs::read_to_string(dir.path().join("hosts.json")).unwrap();
        assert!(text.contains("\"kind\": \"ssh\""));
        assert!(!text.contains("password"));
        remove(dir.path(), id.as_ref().unwrap()).unwrap();
        assert!(list(dir.path()).unwrap().is_empty());
    }
    #[test]
    fn preserves_corrupt_or_future_files_and_rejects_secret_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hosts.json");
        for original in ["broken", "{\"version\":2,\"profiles\":[]}"] {
            fs::write(&path, original).unwrap();
            assert!(save(dir.path(), profile()).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), original);
        }
        let mut value = serde_json::to_value(profile()).unwrap();
        value["password"] = "must-not-save".into();
        assert!(serde_json::from_value::<HostProfile>(value).is_err());
    }
    #[test]
    fn concurrent_saves_do_not_lose_profiles() {
        let dir = tempfile::tempdir().unwrap();
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    save(dir.path(), profile()).unwrap();
                });
            }
        });
        assert_eq!(list(dir.path()).unwrap().len(), 8);
    }
}
