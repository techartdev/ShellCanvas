// SPDX-License-Identifier: MPL-2.0
//! Reviewed installation of an optional native bridge. Review never executes it.
//! The launch path comes from a verified profile installation, never an app frame.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tempfile::TempDir;

const MAX_BINARY: u64 = 128 * 1024 * 1024;
const REVIEW_LIFETIME: Duration = Duration::from_secs(15 * 60);
pub fn supported_client(platform: &str) -> bool {
    matches!(platform, "windows" | "linux" | "macos")
}
pub fn require_supported_client() -> Result<(), String> {
    if supported_client(std::env::consts::OS) {
        Ok(())
    } else {
        Err("Drive Bridge requires a Windows, Linux or macOS ShellCanvas client.".into())
    }
}
#[cfg(windows)]
const BINARY: &str = "shellcanvas-drive-bridge.exe";
#[cfg(not(windows))]
const BINARY: &str = "shellcanvas-drive-bridge";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Installation {
    pub version: u32,
    pub name: String,
    pub sha256: String,
    pub size: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub id: String,
    pub source: String,
    pub installation: Installation,
}
struct Candidate {
    owner: String,
    created: Instant,
    directory: TempDir,
    installation: Installation,
}
#[derive(Clone, Default)]
pub struct Reviews(Arc<Mutex<HashMap<String, Candidate>>>);

fn hash(path: &Path) -> Result<(String, u64), String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Choose a regular executable file.".into());
    }
    let mut reader = file.take(MAX_BINARY + 1);
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        size += read as u64;
        if size > MAX_BINARY {
            return Err("Bridge executable exceeds 128 MiB.".into());
        }
        digest.update(&buffer[..read]);
    }
    if size == 0 {
        return Err("Bridge executable is empty.".into());
    }
    Ok((format!("{:x}", digest.finalize()), size))
}
fn anchor(storage: &Path) -> Result<PathBuf, String> {
    let root = storage.join("drive-bridge");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    root.canonicalize().map_err(|e| e.to_string())
}
fn child_directory(root: &Path, child: &str) -> Result<PathBuf, String> {
    let path = root.join(child);
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let resolved = path.canonicalize().map_err(|e| e.to_string())?;
    if resolved.parent() != Some(root) {
        return Err("Bridge storage directory was redirected.".into());
    }
    Ok(resolved)
}
fn validate(info: &Installation) -> Result<(), String> {
    if info.version != 1
        || info.sha256.len() != 64
        || !info
            .sha256
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || info.size == 0
        || info.size > MAX_BINARY
        || info.name.is_empty()
        || info.name.len() > 512
    {
        return Err("Invalid bridge installation record.".into());
    }
    Ok(())
}
pub(crate) fn verify(path: &Path, info: &Installation) -> Result<(), String> {
    if fs::symlink_metadata(path)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Bridge executable was replaced by a symbolic link.".into());
    }
    let (digest, size) = hash(path)?;
    if digest != info.sha256 || size != info.size {
        return Err(
            "Bridge executable changed after review. Review it again before running it.".into(),
        );
    }
    Ok(())
}
impl Reviews {
    pub fn review(&self, storage: &Path, source: &Path, owner: &str) -> Result<Review, String> {
        let source = source.canonicalize().map_err(|e| e.to_string())?;
        if !fs::metadata(&source).map_err(|e| e.to_string())?.is_file() {
            return Err("Choose a regular executable file.".into());
        }
        let name = source
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("Executable filename is not valid text")?
            .to_string();
        let root = anchor(storage)?;
        let staging = child_directory(&root, "reviews")?;
        let mut pending = self.0.lock().map_err(|_| "Bridge reviews unavailable")?;
        pending.retain(|_, candidate| candidate.created.elapsed() < REVIEW_LIFETIME);
        if pending.len() >= 8 {
            return Err("Close an existing bridge review before opening another.".into());
        }
        let directory = tempfile::tempdir_in(staging).map_err(|e| e.to_string())?;
        let staged = directory.path().join(BINARY);
        let mut original = fs::File::open(&source)
            .map_err(|e| e.to_string())?
            .take(MAX_BINARY + 1);
        let mut copy = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged)
            .map_err(|e| e.to_string())?;
        let size = std::io::copy(&mut original, &mut copy).map_err(|e| e.to_string())?;
        if size > MAX_BINARY {
            return Err("Bridge executable exceeds 128 MiB.".into());
        }
        copy.sync_all().map_err(|e| e.to_string())?;
        drop(copy);
        let (sha256, size) = hash(&staged)?;
        let installation = Installation {
            version: 1,
            name,
            sha256,
            size,
        };
        validate(&installation)?;
        let id = uuid::Uuid::new_v4().to_string();
        pending.insert(
            id.clone(),
            Candidate {
                owner: owner.into(),
                created: Instant::now(),
                directory,
                installation: installation.clone(),
            },
        );
        Ok(Review {
            id,
            source: source.to_string_lossy().into_owned(),
            installation,
        })
    }
    pub fn cancel(&self, id: &str, owner: &str) -> Result<(), String> {
        let mut pending = self.0.lock().map_err(|_| "Bridge reviews unavailable")?;
        if pending.get(id).is_some_and(|item| item.owner != owner) {
            return Err("This review belongs to another window.".into());
        }
        pending.remove(id);
        Ok(())
    }
    pub fn install(&self, storage: &Path, id: &str, owner: &str) -> Result<Installation, String> {
        let candidate = {
            let mut pending = self.0.lock().map_err(|_| "Bridge reviews unavailable")?;
            let item = pending
                .get(id)
                .ok_or("Bridge review expired. Choose the executable again.")?;
            if item.owner != owner {
                return Err("This review belongs to another window.".into());
            }
            pending.remove(id).unwrap()
        };
        if candidate.created.elapsed() >= REVIEW_LIFETIME {
            return Err("Bridge review expired. Choose the executable again.".into());
        }
        let staged = candidate.directory.path().join(BINARY);
        verify(&staged, &candidate.installation)?;
        let root = anchor(storage)?;
        let versions = child_directory(&root, "versions")?;
        let directory = child_directory(&versions, &candidate.installation.sha256)?;
        let target = directory.join(BINARY);
        if !target.try_exists().map_err(|e| e.to_string())? {
            // Atomic publication; never replace the bytes of an active installation.
            let mut temporary =
                tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
            std::io::copy(
                &mut fs::File::open(&staged).map_err(|e| e.to_string())?,
                &mut temporary,
            )
            .map_err(|e| e.to_string())?;
            temporary.as_file().sync_all().map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                temporary
                    .as_file()
                    .set_permissions(fs::Permissions::from_mode(0o700))
                    .map_err(|e| e.to_string())?;
            }
            temporary
                .persist_noclobber(&target)
                .map_err(|e| e.to_string())?;
        }
        verify(&target, &candidate.installation)?;
        let mut record = tempfile::NamedTempFile::new_in(&root).map_err(|e| e.to_string())?;
        record
            .write_all(&serde_json::to_vec(&candidate.installation).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        record.as_file().sync_all().map_err(|e| e.to_string())?;
        record
            .persist(root.join("installation.json"))
            .map_err(|e| e.to_string())?;
        Ok(candidate.installation)
    }
}
pub fn installed(storage: &Path) -> Result<Option<(Installation, PathBuf)>, String> {
    let root = storage.join("drive-bridge");
    let record = root.join("installation.json");
    let file = match fs::File::open(record) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let info: Installation = serde_json::from_reader(file.take(4097)).map_err(|e| e.to_string())?;
    validate(&info)?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let versions = root
        .join("versions")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let directory = versions
        .join(&info.sha256)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if versions.parent() != Some(root.as_path()) || directory.parent() != Some(versions.as_path()) {
        return Err("Bridge installation was redirected.".into());
    }
    let executable = directory.join(BINARY);
    verify(&executable, &info)?;
    Ok(Some((info, executable)))
}

#[tauri::command]
pub async fn drive_bridge_installation(
    app: tauri::AppHandle,
) -> Result<Option<Installation>, String> {
    let storage = crate::profile_store::storage_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        installed(&storage).map(|value| value.map(|(info, _)| info))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn review_drive_bridge(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Reviews>,
) -> Result<Option<Review>, String> {
    require_supported_client()?;
    use tauri::Manager;
    use tauri_plugin_dialog::DialogExt;
    let app = window.app_handle().clone();
    let owner = window.label().to_string();
    let storage = crate::profile_store::storage_dir(&app)?;
    let reviews = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let picker = app
            .dialog()
            .file()
            .set_title("Choose ShellCanvas Drive Bridge");
        #[cfg(windows)]
        let picker = picker.add_filter("Drive Bridge executable", &["exe"]);
        let Some(selected) = picker.blocking_pick_file() else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|_| "Choose a local executable")?;
        reviews.review(&storage, &path, &owner).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn cancel_drive_bridge_review(
    id: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Reviews>,
) -> Result<(), String> {
    let reviews = state.inner().clone();
    let owner = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || reviews.cancel(&id, &owner))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn install_drive_bridge(
    id: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Reviews>,
) -> Result<Installation, String> {
    let _update_operation = crate::update_gate::operation()?;
    require_supported_client()?;
    use tauri::Manager;
    let storage = crate::profile_store::storage_dir(window.app_handle())?;
    let owner = window.label().to_string();
    let reviews = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || reviews.install(&storage, &id, &owner))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bridge_support_is_a_client_platform_decision() {
        for platform in ["windows", "linux", "macos"] {
            assert!(supported_client(platform));
        }
        for platform in ["android", "ios", "web", "unknown"] {
            assert!(!supported_client(platform));
        }
    }
    #[test]
    fn review_pins_bytes_is_window_owned_and_install_survives_restart() {
        let profile = tempfile::tempdir().unwrap();
        let download = tempfile::tempdir().unwrap();
        let source = download.path().join(BINARY);
        fs::write(&source, b"reviewed binary fixture; never executed").unwrap();
        let reviews = Reviews::default();
        let review = reviews.review(profile.path(), &source, "main").unwrap();
        assert!(reviews
            .install(profile.path(), &review.id, "foreign")
            .is_err());
        fs::write(&source, b"changed download").unwrap();
        let accepted = reviews.install(profile.path(), &review.id, "main").unwrap();
        assert!(reviews.install(profile.path(), &review.id, "main").is_err());
        drop(reviews);
        let (saved, executable) = installed(profile.path()).unwrap().unwrap();
        assert_eq!(saved.sha256, accepted.sha256);
        assert_eq!(
            fs::read(&executable).unwrap(),
            b"reviewed binary fixture; never executed"
        );
        fs::write(executable, b"tampered installed bytes").unwrap();
        assert!(installed(profile.path())
            .unwrap_err()
            .contains("changed after review"));
    }
    #[test]
    fn cancelled_review_cannot_install_and_invalid_record_cannot_supply_a_path() {
        let profile = tempfile::tempdir().unwrap();
        assert!(installed(profile.path()).unwrap().is_none());
        let source = profile.path().join("candidate");
        fs::write(&source, b"fixture").unwrap();
        let reviews = Reviews::default();
        let review = reviews.review(profile.path(), &source, "main").unwrap();
        reviews.cancel(&review.id, "main").unwrap();
        assert!(reviews.install(profile.path(), &review.id, "main").is_err());
        let malicious = Installation {
            version: 1,
            name: "fixture".into(),
            sha256: "../elsewhere".into(),
            size: 1,
        };
        fs::write(
            profile.path().join("drive-bridge/installation.json"),
            serde_json::to_vec(&malicious).unwrap(),
        )
        .unwrap();
        assert!(installed(profile.path()).is_err());
    }
    #[test]
    fn changed_review_does_not_replace_the_existing_installation() {
        let profile = tempfile::tempdir().unwrap();
        let source = profile.path().join("candidate");
        fs::write(&source, b"original approved fixture").unwrap();
        let reviews = Reviews::default();
        let first = reviews.review(profile.path(), &source, "main").unwrap();
        let installed_first = reviews.install(profile.path(), &first.id, "main").unwrap();
        fs::write(&source, b"new candidate fixture").unwrap();
        let next = reviews.review(profile.path(), &source, "main").unwrap();
        let staged = reviews
            .0
            .lock()
            .unwrap()
            .get(&next.id)
            .unwrap()
            .directory
            .path()
            .join(BINARY);
        fs::write(staged, b"tampered review").unwrap();
        assert!(reviews.install(profile.path(), &next.id, "main").is_err());
        assert_eq!(
            installed(profile.path()).unwrap().unwrap().0.sha256,
            installed_first.sha256
        );
    }
}
