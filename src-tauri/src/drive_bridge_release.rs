// SPDX-License-Identifier: MPL-2.0
//! Download only publisher-signed bridge releases. Never execute during review.
use crate::drive_bridge_install::{self, Review, Reviews, MAX_BINARY};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, time::Duration};
use tauri::Manager;
use tokio::io::AsyncWriteExt;

const RELEASES: &str = "https://github.com/techartdev/ShellCanvas-DriveBridge/releases";
const PUBLIC_KEY: &str = include_str!("../bridge-release.pub");
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Asset {
    sha256: String,
    size: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema: u32,
    protocol: u32,
    version: String,
    platforms: BTreeMap<String, Asset>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseStatus {
    version: String,
    target: String,
    available: bool,
    update_available: bool,
    driver: Driver,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Driver {
    name: String,
    detected: bool,
    guidance: String,
    url: String,
}

fn target(os: &str, arch: &str) -> Result<String, String> {
    if !drive_bridge_install::supported_client(os) || !matches!(arch, "x86_64" | "aarch64") {
        return Err("Drive Bridge has no package for this client platform.".into());
    }
    Ok(format!("{os}-{arch}"))
}
fn asset_name(version: &str, target: &str) -> String {
    format!(
        "shellcanvas-drive-bridge-{version}-{target}{}",
        if target.starts_with("windows-") {
            ".exe"
        } else {
            ""
        }
    )
}
fn verify_manifest(bytes: &[u8], signature: &[u8]) -> Result<Manifest, String> {
    let encoded = std::str::from_utf8(signature)
        .map_err(|e| e.to_string())?
        .trim();
    let decoded = STANDARD
        .decode(encoded)
        .map_err(|e| format!("Invalid bridge signature: {e}"))?;
    let signature = minisign_verify::Signature::decode(
        std::str::from_utf8(&decoded).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    minisign_verify::PublicKey::decode(PUBLIC_KEY)
        .map_err(|e| e.to_string())?
        .verify(bytes, &signature, false)
        .map_err(|_| {
            "Bridge release signature could not be verified. Nothing was installed.".to_string()
        })?;
    let manifest: Manifest = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}
fn validate_manifest(manifest: &Manifest) -> Result<(), String> {
    let version = semver::Version::parse(&manifest.version).map_err(|e| e.to_string())?;
    if manifest.schema != 1
        || manifest.protocol != shellcanvas_services::wire::PROTOCOL
        || !version.pre.is_empty()
        || !version.build.is_empty()
    {
        return Err(
            "This bridge release requires a different ShellCanvas protocol version.".into(),
        );
    }
    for (platform, asset) in &manifest.platforms {
        let (os, arch) = platform.split_once('-').ok_or("Invalid bridge platform")?;
        target(os, arch)?;
        if asset.size == 0
            || asset.size > MAX_BINARY
            || asset.sha256.len() != 64
            || !asset
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("Invalid bridge release asset.".into());
        }
    }
    Ok(())
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(true)
        .user_agent("ShellCanvas Drive Bridge installer")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())
}
async fn small_file(client: &reqwest::Client, url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| format!("Bridge release is unavailable: {e}"))?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > limit {
            return Err("Bridge release metadata exceeds its size limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn latest(client: &reqwest::Client) -> Result<Manifest, String> {
    let bytes = small_file(
        client,
        &format!("{RELEASES}/latest/download/bridge-release.json"),
        64 * 1024,
    )
    .await?;
    // Resolve the signature at the same immutable tag to avoid a latest-release
    // change pairing metadata with a different signature. Verify before using it.
    let hint: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let version = hint
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or("Missing bridge version")?;
    let parsed = semver::Version::parse(version).map_err(|e| e.to_string())?;
    if !parsed.pre.is_empty() || !parsed.build.is_empty() {
        return Err("Invalid release version".into());
    }
    let signature = small_file(
        client,
        &format!("{RELEASES}/download/v{parsed}/bridge-release.json.sig"),
        4096,
    )
    .await?;
    verify_manifest(&bytes, &signature)
}
fn driver() -> Driver {
    #[cfg(windows)]
    {
        let detected = ["ProgramFiles(x86)", "ProgramFiles"]
            .iter()
            .filter_map(std::env::var_os)
            .any(|root| {
                Path::new(&root)
                    .join("WinFsp/bin")
                    .join(if cfg!(target_arch = "aarch64") {
                        "winfsp-a64.dll"
                    } else {
                        "winfsp-x64.dll"
                    })
                    .is_file()
            });
        Driver { name: "WinFsp".into(), detected, guidance: "Install the official WinFsp runtime once, then recheck. Driver installation may require administrator approval and a restart.".into(), url: "https://winfsp.dev/rel/".into() }
    }
    #[cfg(target_os = "macos")]
    {
        Driver { name: "macFUSE".into(), detected: Path::new("/Library/Filesystems/macfuse.fs").exists(), guidance: "Install macFUSE separately and follow its system approval instructions. Native macOS mount acceptance is still pending.".into(), url: "https://macfuse.github.io/".into() }
    }
    #[cfg(target_os = "linux")]
    {
        Driver { name: "FUSE".into(), detected: Path::new("/dev/fuse").exists() && ["/usr/bin/fusermount3", "/bin/fusermount3", "/usr/bin/fusermount", "/bin/fusermount"].iter().any(|p| Path::new(p).exists()), guidance: "Install your distribution's FUSE runtime and mount helper. Access to /dev/fuse is also required.".into(), url: "https://github.com/libfuse/libfuse".into() }
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        Driver {
            name: "Unsupported client".into(),
            detected: false,
            guidance: "Use a supported desktop client.".into(),
            url: RELEASES.into(),
        }
    }
}
#[tauri::command]
pub async fn drive_bridge_release_status(app: tauri::AppHandle) -> Result<ReleaseStatus, String> {
    let target = target(std::env::consts::OS, std::env::consts::ARCH)?;
    let manifest = latest(&client()?).await?;
    let storage = crate::profile_store::storage_dir(&app)?;
    let installed =
        tauri::async_runtime::spawn_blocking(move || drive_bridge_install::installed(&storage))
            .await
            .map_err(|e| e.to_string())??;
    let update_available = match installed.and_then(|(info, _)| info.release_version) {
        Some(version) => {
            semver::Version::parse(&version).map_err(|e| e.to_string())?
                < semver::Version::parse(&manifest.version).map_err(|e| e.to_string())?
        }
        None => true,
    };
    Ok(ReleaseStatus {
        available: manifest.platforms.contains_key(&target),
        version: manifest.version,
        target,
        update_available,
        driver: driver(),
    })
}
#[tauri::command]
pub async fn download_drive_bridge(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Reviews>,
) -> Result<Review, String> {
    let _operation = crate::update_gate::operation()?;
    let target = target(std::env::consts::OS, std::env::consts::ARCH)?;
    let client = client()?;
    let manifest = latest(&client).await?;
    let asset = manifest
        .platforms
        .get(&target)
        .ok_or("No published bridge package for this client yet.")?
        .clone();
    let directory = tempfile::tempdir().map_err(|e| e.to_string())?;
    let name = asset_name(&manifest.version, &target);
    let path = directory.path().join(&name);
    let mut response = client
        .get(format!("{RELEASES}/download/v{}/{name}", manifest.version))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .await
        .map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut size = 0u64;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        size += chunk.len() as u64;
        if size > asset.size || size > MAX_BINARY {
            return Err("Bridge download exceeded its signed size.".into());
        }
        hash.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
    }
    file.sync_all().await.map_err(|e| e.to_string())?;
    drop(file);
    if size != asset.size || format!("{:x}", hash.finalize()) != asset.sha256 {
        return Err("Bridge download failed integrity verification. Nothing was installed.".into());
    }
    let storage = crate::profile_store::storage_dir(window.app_handle())?;
    let owner = window.label().to_owned();
    let reviews = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = reviews
            .review_release(&storage, &path, &owner, &manifest.version, &target)
            .and_then(|review| {
                if review.installation.sha256 != asset.sha256
                    || review.installation.size != asset.size
                {
                    reviews.cancel(&review.id, &owner)?;
                    return Err(
                        "Bridge staging failed integrity verification. Nothing was installed."
                            .into(),
                    );
                }
                Ok(review)
            });
        drop(directory);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn current_release_signature_matches_the_desktop_protocol() {
        let bytes = include_bytes!("../tests/fixtures/bridge-release/v0.1.1.json");
        let signature = include_bytes!("../tests/fixtures/bridge-release/v0.1.1.json.sig");
        let manifest = verify_manifest(bytes, signature).unwrap();
        assert_eq!(manifest.version, "0.1.1");
        assert_eq!(manifest.protocol, shellcanvas_services::wire::PROTOCOL);
        assert_eq!(manifest.platforms.len(), 4);
    }
    const RELEASE: &[u8] = include_bytes!("../tests/fixtures/bridge-release/bridge-release.json");
    const SIGNATURE: &[u8] =
        include_bytes!("../tests/fixtures/bridge-release/bridge-release.json.sig");
    #[test]
    fn signed_but_obsolete_release_is_rejected_and_tampering_fails_signature() {
        let error = verify_manifest(RELEASE, SIGNATURE).err().unwrap();
        assert!(error.contains("different ShellCanvas protocol"));
        let changed = String::from_utf8(RELEASE.to_vec())
            .unwrap()
            .replace("0.1.0", "0.1.1");
        assert!(verify_manifest(changed.as_bytes(), SIGNATURE).is_err());
    }
    #[tokio::test]
    #[ignore = "Downloads the public release into a disposable profile; opt-in network test"]
    async fn official_release_download_installs_verified_bytes_in_an_isolated_profile() {
        let client = client().unwrap();
        let manifest = latest(&client).await.unwrap();
        let target = target(std::env::consts::OS, std::env::consts::ARCH).unwrap();
        let asset = manifest.platforms.get(&target).unwrap();
        let name = asset_name(&manifest.version, &target);
        let bytes = small_file(
            &client,
            &format!("{RELEASES}/download/v{}/{name}", manifest.version),
            MAX_BINARY as usize,
        )
        .await
        .unwrap();
        assert_eq!(bytes.len() as u64, asset.size);
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), asset.sha256);
        let profile = tempfile::tempdir().unwrap();
        let source = profile.path().join(name);
        std::fs::write(&source, bytes).unwrap();
        let reviews = Reviews::default();
        let review = reviews
            .review_release(profile.path(), &source, "test", &manifest.version, &target)
            .unwrap();
        assert_eq!(review.installation.sha256, asset.sha256);
        reviews.install(profile.path(), &review.id, "test").unwrap();
        let (info, executable) = drive_bridge_install::installed(profile.path())
            .unwrap()
            .unwrap();
        assert_eq!(
            info.release_version.as_deref(),
            Some(manifest.version.as_str())
        );
        assert_eq!(info.target.as_deref(), Some(target.as_str()));
        // Execute only after both publisher authentication and the installed-byte check.
        let output = std::process::Command::new(executable)
            .arg("--version")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            format!(
                "ShellCanvas Drive Bridge {} (protocol {})",
                manifest.version,
                shellcanvas_services::wire::PROTOCOL
            )
        );
    }
    #[test]
    fn package_selection_is_local_and_names_cannot_escape_release_paths() {
        assert_eq!(target("windows", "x86_64").unwrap(), "windows-x86_64");
        assert!(target("android", "aarch64").is_err());
        assert!(target("linux", "../../file").is_err());
        assert_eq!(
            asset_name("0.1.0", "windows-x86_64"),
            "shellcanvas-drive-bridge-0.1.0-windows-x86_64.exe"
        );
    }
    #[test]
    fn rejects_incompatible_and_malformed_release_metadata() {
        let mut manifest = Manifest {
            schema: 1,
            protocol: shellcanvas_services::wire::PROTOCOL,
            version: "0.1.0".into(),
            platforms: BTreeMap::from([(
                "windows-x86_64".into(),
                Asset {
                    size: 10,
                    sha256: "a".repeat(64),
                },
            )]),
        };
        assert!(validate_manifest(&manifest).is_ok());
        manifest.protocol = shellcanvas_services::wire::PROTOCOL + 1;
        assert!(validate_manifest(&manifest).is_err());
        manifest.protocol = shellcanvas_services::wire::PROTOCOL;
        manifest.version = "../../other".into();
        assert!(validate_manifest(&manifest).is_err());
        assert!(verify_manifest(b"{}", b"invalid").is_err());
    }
}
