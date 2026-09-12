// SPDX-License-Identifier: MPL-2.0
use serde::Serialize;
use std::{sync::Mutex, time::Duration};
use tauri::{ipc::Channel, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const ENDPOINT: &str =
    "https://github.com/techartdev/ShellCanvas/releases/latest/download/latest.json";

fn update_target(os: &str, arch: &str, bundle: Option<&str>) -> Result<String, String> {
    let kind = match (os, bundle) {
        ("windows", Some("msi")) => "msi",
        ("windows", Some("nsis") | None) => "nsis",
        ("macos", Some("app")) => "app",
        ("linux", Some("appimage")) => "appimage",
        ("linux", Some("deb")) => "deb",
        ("linux", Some("rpm")) => "rpm",
        _ => {
            return Err(
                "Install a packaged ShellCanvas release to use in-app updates on this system."
                    .into(),
            )
        }
    };
    let os = if os == "macos" { "darwin" } else { os };
    Ok(format!("{os}-{arch}-{kind}"))
}

fn current_target() -> Result<String, String> {
    if cfg!(target_os = "macos")
        && !std::env::current_exe()
            .map_err(crate::error)?
            .ancestors()
            .any(|p| p.extension().is_some_and(|extension| extension == "app"))
    {
        return Err("Install the ShellCanvas app bundle before using in-app updates.".into());
    }
    use tauri::utils::{config::BundleType, platform::bundle_type};
    let bundle = match bundle_type() {
        Some(BundleType::Nsis) => Some("nsis"),
        Some(BundleType::Msi) => Some("msi"),
        Some(BundleType::App) => Some("app"),
        Some(BundleType::AppImage) => Some("appimage"),
        Some(BundleType::Deb) => Some("deb"),
        Some(BundleType::Rpm) => Some("rpm"),
        _ => None,
    };
    update_target(std::env::consts::OS, std::env::consts::ARCH, bundle)
}

pub struct Updates {
    task: tokio::sync::Mutex<()>,
    available: Mutex<Option<Update>>,
    prepared: Mutex<Option<(Update, Vec<u8>)>>,
    cancel: tokio::sync::watch::Sender<bool>,
}
impl Default for Updates {
    fn default() -> Self {
        Self {
            task: tokio::sync::Mutex::new(()),
            available: Mutex::new(None),
            prepared: Mutex::new(None),
            cancel: tokio::sync::watch::channel(false).0,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    version: String,
    current_version: String,
    notes: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

fn trusted_download(url: &str) -> bool {
    url.starts_with("https://github.com/techartdev/ShellCanvas/releases/download/v")
        && !url.contains(['?', '#'])
}

#[tauri::command]
pub async fn check_app_update(
    app: tauri::AppHandle,
    updates: State<'_, Updates>,
) -> Result<Option<Release>, String> {
    let _task = updates
        .task
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;
    let updater = app
        .updater_builder()
        .target(current_target()?)
        .endpoints(vec![ENDPOINT.parse().map_err(crate::error)?])
        .map_err(crate::error)?
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(crate::error)?;
    let update = updater.check().await.map_err(|e| match e {
        tauri_plugin_updater::Error::TargetNotFound(_) => {
            "A signed update is not yet published for this operating system and package type."
                .to_string()
        }
        _ => format!("Could not check for updates. Check your connection and try again. ({e})"),
    })?;
    if let Some(update) = &update {
        if !trusted_download(update.download_url.as_str()) {
            return Err("The update does not point to an official ShellCanvas release.".into());
        }
    }
    let release = update.as_ref().map(|u| Release {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone().unwrap_or_default(),
    });
    *updates.available.lock().unwrap() = update;
    *updates.prepared.lock().unwrap() = None;
    Ok(release)
}

#[tauri::command]
pub async fn download_app_update(
    version: String,
    progress: Channel<Progress>,
    updates: State<'_, Updates>,
) -> Result<(), String> {
    let _task = updates
        .task
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;
    let mut update = updates
        .available
        .lock()
        .unwrap()
        .clone()
        .ok_or("Check for updates first.")?;
    if update.version != version {
        return Err("The available update changed. Review it again.".into());
    }
    *updates.prepared.lock().unwrap() = None;
    updates.cancel.send_replace(false);
    let mut cancel = updates.cancel.subscribe();
    update.timeout = Some(Duration::from_secs(600));
    let mut downloaded = 0u64;
    let bytes = tokio::select! {
        biased;
        _ = cancel.changed() => return Err("Update download canceled.".into()),
        bytes = update.download(|chunk, total| {
            downloaded = downloaded.saturating_add(chunk as u64);
            let _ = progress.send(Progress { downloaded, total });
        }, || {}) => bytes.map_err(|e| format!("The update could not be downloaded and verified: {e}"))?,
    };
    let mut prepared = updates.prepared.lock().unwrap();
    if *updates.cancel.borrow() {
        return Err("Update download canceled.".into());
    }
    *prepared = Some((update, bytes));
    Ok(())
}

#[tauri::command]
pub fn cancel_app_update(updates: State<'_, Updates>) {
    updates.cancel.send_replace(true);
    *updates.prepared.lock().unwrap() = None;
}

#[tauri::command]
pub async fn install_app_update(
    version: String,
    app: tauri::AppHandle,
    state: State<'_, crate::DesktopState>,
    updates: State<'_, Updates>,
) -> Result<(), String> {
    let _task = updates
        .task
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;
    let mut closing = state.mount_transition.lock().await;
    if *closing {
        return Err("ShellCanvas is already closing.".into());
    }
    if state.mappings.has_running() {
        return Err("Detach local drives in Settings → Files before updating ShellCanvas.".into());
    }
    let transfers = state.transfers.lock().await;
    if transfers.has_pending() {
        return Err("Finish or cancel queued file transfers before updating.".into());
    }
    let _installation = crate::update_gate::reserve()?;
    let (update, bytes) = {
        let mut prepared = updates.prepared.lock().unwrap();
        if prepared
            .as_ref()
            .is_none_or(|(update, _)| update.version != version)
        {
            return Err("Download and verify this update before installing it.".into());
        }
        prepared.take().unwrap()
    };
    *closing = true;
    // Windows launches the installer and exits here. Other platforms replace the
    // bundle in place and then restart. Failure keeps the current app available.
    if let Err(error) = update.install(bytes) {
        *closing = false;
        return Err(format!("The update could not be installed: {error}"));
    }
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn updates_keep_the_platform_architecture_and_package_type() {
        for (os, arch, kind, expected) in [
            ("windows", "x86_64", "msi", "windows-x86_64-msi"),
            ("windows", "x86_64", "nsis", "windows-x86_64-nsis"),
            ("macos", "aarch64", "app", "darwin-aarch64-app"),
            ("macos", "x86_64", "app", "darwin-x86_64-app"),
            ("linux", "x86_64", "appimage", "linux-x86_64-appimage"),
            ("linux", "x86_64", "deb", "linux-x86_64-deb"),
            ("linux", "aarch64", "rpm", "linux-aarch64-rpm"),
        ] {
            assert_eq!(update_target(os, arch, Some(kind)).unwrap(), expected);
        }
        assert!(update_target("linux", "x86_64", None).is_err());
        assert!(update_target("macos", "x86_64", None).is_err());
        assert!(update_target("android", "aarch64", None).is_err());
    }
    #[test]
    fn only_official_release_downloads_are_accepted() {
        assert!(trusted_download("https://github.com/techartdev/ShellCanvas/releases/download/v0.2.0/ShellCanvas.AppImage"));
        for url in [
            "http://github.com/techartdev/ShellCanvas/releases/download/v1/file",
            "https://github.com/other/ShellCanvas/releases/download/v1/file",
            "https://github.com.evil/techartdev/ShellCanvas/releases/download/v1/file",
            "https://github.com/techartdev/ShellCanvas/releases/download/v1/file?redirect=evil",
        ] {
            assert!(!trusted_download(url));
        }
    }
}
