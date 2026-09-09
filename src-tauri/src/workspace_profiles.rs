// SPDX-License-Identifier: MPL-2.0
//! Saved service assignments. Credentials never enter the serialized profile.
use crate::adapters::AdapterConnectionOptions;
use serde::{Deserialize, Serialize};
use shellcanvas_adapter_runtime::catalog::{AdapterInfo, FieldKind};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WorkspaceProfile {
    Adapters(AdapterConnectionOptions),
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedWorkspace {
    pub id: String,
    pub revision: String,
    pub profile: WorkspaceProfile,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Store {
    version: u32,
    profiles: Vec<SavedWorkspace>,
}
const MAX_BYTES: u64 = 2 * 1024 * 1024;
fn load(path: &Path) -> Result<Store, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Store {
                version: 1,
                profiles: vec![],
            })
        }
        Err(error) => return Err(format!("Cannot read workspace profiles: {error}")),
    };
    let mut bytes = vec![];
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Workspace profiles exceed the metadata size limit".into());
    }
    let store: Store = serde_json::from_slice(&bytes)
        .map_err(|_| "Workspace profiles are invalid; the file was not changed")?;
    if store.version != 1 {
        return Err(
            "Workspace profiles use an unsupported version; the file was not changed".into(),
        );
    }
    let mut ids = HashSet::new();
    for saved in &store.profiles {
        if uuid::Uuid::parse_str(&saved.id).is_err()
            || uuid::Uuid::parse_str(&saved.revision).is_err()
            || !ids.insert(&saved.id)
        {
            return Err("Workspace profiles have invalid or duplicate identities".into());
        }
        let WorkspaceProfile::Adapters(options) = &saved.profile;
        options.validate()?;
    }
    Ok(store)
}
fn locked<T>(dir: &Path, action: impl FnOnce(&Path) -> Result<T, String>) -> Result<T, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("workspaces.lock"))
        .map_err(|e| e.to_string())?;
    lock.lock().map_err(|e| e.to_string())?;
    action(&dir.join("workspaces.json"))
}
fn write(path: &Path, store: &Store) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Workspace profiles exceed the metadata size limit".into());
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(path.parent().ok_or("Invalid workspace storage")?)
            .map_err(|e| e.to_string())?;
    temporary.write_all(&bytes).map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
fn sanitized(
    mut options: AdapterConnectionOptions,
    installed: &[AdapterInfo],
) -> Result<AdapterConnectionOptions, String> {
    options.name = options.name.trim().into();
    options.validate()?;
    for source in &mut options.sources {
        if source.id == crate::builtin_ssh::ID {
            crate::builtin_ssh::options(source)?;
        }
        let adapter = installed
            .iter()
            .find(|item| item.id == source.id && item.revision == source.revision && item.enabled)
            .ok_or(
                "An adapter changed or is unavailable; reopen the connection form before saving",
            )?;
        let input = source
            .configuration
            .as_object()
            .ok_or("Adapter configuration must be an object")?;
        if input
            .keys()
            .any(|key| !adapter.configuration.iter().any(|field| &field.id == key))
        {
            return Err("Unknown adapter configuration field".into());
        }
        let mut public = serde_json::Map::new();
        for field in &adapter.configuration {
            if matches!(field.kind, FieldKind::Password) {
                continue;
            }
            if let Some(value) = input.get(&field.id).or(field.default.as_ref()) {
                let valid = match field.kind {
                    FieldKind::Text => value.is_string(),
                    FieldKind::Number => value.is_number(),
                    FieldKind::Boolean => value.is_boolean(),
                    FieldKind::Password => false,
                };
                if !valid || (field.required && value.as_str().is_some_and(str::is_empty)) {
                    return Err(format!("Invalid value for {}", field.label));
                }
                public.insert(field.id.clone(), value.clone());
            } else if field.required {
                return Err(format!("{} is required", field.label));
            }
        }
        source.configuration = serde_json::Value::Object(public);
    }
    Ok(options)
}
fn save(
    dir: &Path,
    options: AdapterConnectionOptions,
    id: Option<String>,
    revision: Option<String>,
    installed: &[AdapterInfo],
) -> Result<SavedWorkspace, String> {
    let options = sanitized(options, installed)?;
    if id.is_some() != revision.is_some() {
        return Err("A saved workspace identity requires its revision".into());
    }
    locked(dir, |path| {
        let mut store = load(path)?;
        let index = if let Some(id) = &id {
            Some(
                store
                    .profiles
                    .iter()
                    .position(|item| &item.id == id && Some(&item.revision) == revision.as_ref())
                    .ok_or(
                        "This workspace profile changed or was removed; reload it before saving",
                    )?,
            )
        } else {
            None
        };
        let saved = SavedWorkspace {
            id: id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            revision: uuid::Uuid::new_v4().to_string(),
            profile: WorkspaceProfile::Adapters(options),
        };
        if let Some(index) = index {
            store.profiles[index] = saved.clone();
        } else {
            store.profiles.push(saved.clone());
        }
        write(path, &store)?;
        Ok(saved)
    })
}
fn remove(dir: &Path, id: &str, revision: &str) -> Result<(), String> {
    locked(dir, |path| {
        let mut store = load(path)?;
        let index = store
            .profiles
            .iter()
            .position(|item| item.id == id && item.revision == revision)
            .ok_or("This workspace profile changed or was removed; reload it before removing")?;
        store.profiles.remove(index);
        write(path, &store)
    })
}
#[tauri::command]
pub async fn list_workspace_profiles(app: tauri::AppHandle) -> Result<Vec<SavedWorkspace>, String> {
    let dir = crate::profile_store::storage_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&dir, |path| Ok(load(path)?.profiles)))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn save_workspace_profile(
    options: AdapterConnectionOptions,
    id: Option<String>,
    revision: Option<String>,
    app: tauri::AppHandle,
) -> Result<SavedWorkspace, String> {
    let dir = crate::profile_store::storage_dir(&app)?;
    let catalog = crate::adapters::catalog(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut installed = catalog.list().map_err(|e| e.to_string())?;
        installed.push(crate::builtin_ssh::info());
        save(&dir, options, id, revision, &installed)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn remove_workspace_profile(
    id: String,
    revision: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let dir = crate::profile_store::storage_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || remove(&dir, &id, &revision))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn installed() -> Vec<AdapterInfo> {
        vec![serde_json::from_value(json!({"id":"dev.fixture","name":"Fixture","version":"1.0.0","description":"","platform":"windows-x86_64","entrypoint":"fixture.exe","configuration":[{"id":"endpoint","label":"Endpoint","kind":"text","required":true},{"id":"token","label":"Token","kind":"password","required":true}],"generation":"one","revision":"one","enabled":true,"fileCount":1,"bytes":1})).unwrap()]
    }
    fn options() -> AdapterConnectionOptions {
        serde_json::from_value(json!({"name":"Mixed workspace","sources":[{"key":"one","id":"dev.fixture","revision":"one","configuration":{"endpoint":"opaque:device","token":"never-persist"}},{"key":"two","id":"dev.fixture","revision":"one","configuration":{"endpoint":"opaque:console","token":"never-persist"}}],"bindings":{"files":"one","console":"two"}})).unwrap()
    }
    #[test]
    fn profiles_roundtrip_without_credentials_and_refuse_stale_updates_and_removals() {
        let dir = tempfile::tempdir().unwrap();
        let first = save(dir.path(), options(), None, None, &installed()).unwrap();
        let bytes = fs::read_to_string(dir.path().join("workspaces.json")).unwrap();
        assert!(!bytes.contains("never-persist"));
        assert!(!bytes.contains("token"));
        let restored = locked(dir.path(), |p| Ok(load(p)?.profiles)).unwrap();
        assert_eq!(restored[0].id, first.id);
        let WorkspaceProfile::Adapters(restored_options) = &restored[0].profile;
        assert_eq!(restored_options.sources.len(), 2);
        assert_eq!(restored_options.bindings["console"], "two");
        assert_eq!(
            restored_options.sources[1].configuration["endpoint"],
            "opaque:console"
        );
        let mut changed = options();
        changed.name = "Renamed".into();
        let second = save(
            dir.path(),
            changed,
            Some(first.id.clone()),
            Some(first.revision.clone()),
            &installed(),
        )
        .unwrap();
        assert!(save(
            dir.path(),
            options(),
            Some(first.id.clone()),
            Some(first.revision.clone()),
            &installed()
        )
        .is_err());
        assert!(remove(dir.path(), &first.id, &first.revision).is_err());
        remove(dir.path(), &second.id, &second.revision).unwrap();
        assert!(locked(dir.path(), |p| Ok(load(p)?.profiles))
            .unwrap()
            .is_empty());
    }
    #[test]
    fn unknown_fields_missing_adapters_and_invalid_roles_cannot_be_saved() {
        let dir = tempfile::tempdir().unwrap();
        assert!(save(dir.path(), options(), None, None, &[]).is_err());
        let mut invalid = options();
        invalid.sources[0].configuration["hiddenSecret"] = json!("secret");
        assert!(save(dir.path(), invalid, None, None, &installed()).is_err());
        let mut invalid = options();
        invalid.bindings.insert("system".into(), "one".into());
        assert!(save(dir.path(), invalid, None, None, &installed()).is_err());
        let mut invalid = options();
        invalid.sources[0].configuration["endpoint"] = json!(42);
        assert!(save(dir.path(), invalid, None, None, &installed()).is_err());
        assert!(!dir.path().join("workspaces.json").exists());
    }
    #[test]
    fn concurrent_profile_creates_survive_and_corrupt_or_future_storage_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let path = dir.path();
                scope.spawn(move || save(path, options(), None, None, &installed()).unwrap());
            }
        });
        assert_eq!(
            locked(dir.path(), |p| Ok(load(p)?.profiles)).unwrap().len(),
            8
        );
        for bytes in ["not json", "{\"version\":2,\"profiles\":[]}"] {
            fs::write(dir.path().join("workspaces.json"), bytes).unwrap();
            assert!(save(dir.path(), options(), None, None, &installed()).is_err());
            assert_eq!(
                fs::read_to_string(dir.path().join("workspaces.json")).unwrap(),
                bytes
            );
        }
    }
}
