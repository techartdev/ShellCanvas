// SPDX-License-Identifier: MPL-2.0
//! OS-specific storage discovery is optional and uses the same SSH connection
//! as SFTP. Ordinary browsing remains independent of command availability.
use crate::{Connection, SftpBrowser};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use sha2::{Digest, Sha256};
use shellcanvas_services::*;
use std::{collections::HashSet, sync::Arc};
use tokio::sync::{Mutex, OnceCell};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Platform {
    Linux,
    Mac,
    Windows,
    Other,
}

fn known_platform(provider: &str) -> Option<Platform> {
    match provider {
        "linux" => Some(Platform::Linux),
        "macos" => Some(Platform::Mac),
        "windows" => Some(Platform::Windows),
        _ => None,
    }
}

async fn discover_platform(cache: &OnceCell<Platform>, commands: &dyn CommandProbe) -> Platform {
    // A failed probe is inconclusive, not a permanent unsupported-platform result.
    // Cache only positive identification so Refresh can recover after a timeout.
    cache
        .get_or_try_init(|| async {
            match commands.probe("uname -s").await.as_deref() {
                Ok("Linux") => Ok(Platform::Linux),
                Ok("Darwin") => Ok(Platform::Mac),
                _ => {
                    let command = powershell(
                        "if ([Environment]::OSVersion.Platform -eq 'Win32NT') { 'Windows' }",
                    );
                    match commands.probe(&command).await.as_deref() {
                        Ok("Windows") => Ok(Platform::Windows),
                        _ => Err(()),
                    }
                }
            }
        })
        .await
        .copied()
        .unwrap_or(Platform::Other)
}

pub struct SshFileBrowser {
    browser: Arc<SftpBrowser>,
    connection: Arc<Connection>,
    platform: OnceCell<Platform>,
    changes: Mutex<()>,
}
impl SshFileBrowser {
    pub fn new(browser: Arc<SftpBrowser>, connection: Arc<Connection>) -> Self {
        Self {
            browser,
            connection,
            platform: OnceCell::new(),
            changes: Mutex::new(()),
        }
    }
    /// Reuse identification already confirmed on this same SSH connection.
    pub fn with_identified_provider(mut self, provider: &str) -> Self {
        if let Some(platform) = known_platform(provider) {
            self.platform = OnceCell::new_with(Some(platform));
        }
        self
    }
    async fn platform(&self) -> Platform {
        discover_platform(&self.platform, self.connection.as_ref()).await
    }
    async fn inventory(&self) -> Result<FileVolumes> {
        let mut result = match self.platform().await {
            Platform::Linux => {
                let mounts = self
                    .connection
                    .exec_readonly("cat /proc/self/mountinfo")
                    .await?;
                let mut result = linux_mounts(&mounts)?;
                match self
                    .connection
                    .exec_readonly(
                        "lsblk --json --paths --output NAME,TYPE,FSTYPE,LABEL,UUID,MAJ:MIN",
                    )
                    .await
                {
                    Ok(blocks) => {
                        let can_manage = self
                            .connection
                            .exec_readonly("command -v udisksctl")
                            .await
                            .is_ok();
                        linux_blocks(&mut result, &serde_json::from_str(&blocks)?, can_manage);
                        if !can_manage {
                            result.notices.push("Mount controls require UDisks on this host. Existing mounts remain browsable.".into());
                        }
                    }
                    Err(_) => result.notices.push(
                        "Unmounted device discovery requires lsblk. Existing mounts are shown."
                            .into(),
                    ),
                }
                result
            }
            Platform::Mac => {
                let data = self
                    .connection
                    .exec_readonly("diskutil list -plist | plutil -convert json -o - -- -")
                    .await?;
                let mut result = mac_volumes(&serde_json::from_str(&data)?);
                // Includes network mounts that diskutil does not enumerate.
                match self.connection.exec_readonly("mount").await {
                    Ok(mounts) => mac_mounts(&mut result, &mounts),
                    Err(_) => result
                        .notices
                        .push("Additional network mount discovery failed.".into()),
                }
                result
            }
            Platform::Windows => {
                match self
                    .connection
                    .exec_readonly(&powershell(WINDOWS_VOLUMES))
                    .await
                {
                    Ok(data) => windows_volumes(&serde_json::from_str(&data)?),
                    Err(_) => {
                        let data = self
                            .connection
                            .exec_readonly(&powershell(WINDOWS_LOGICAL_DRIVES))
                            .await?;
                        let mut result = windows_volumes(&serde_json::from_str(&data)?);
                        result.notices.push("Detailed storage discovery timed out or failed. Only logical drives are shown.".into());
                        result
                    }
                }
            }
            Platform::Other => return Ok(FileVolumes::unavailable()),
        };
        result.volumes.sort_by(|a, b| a.id.cmp(&b.id));
        // Includes mount IDs, device UUIDs, locations and offered actions. Changes
        // elsewhere in the inventory conservatively require another review.
        result.revision = format!("{:x}", Sha256::digest(serde_json::to_vec(&result.volumes)?));
        Ok(result)
    }
}
#[async_trait]
impl FileSystemProvider for SshFileBrowser {
    fn supports_local_mount(&self) -> bool {
        true
    }
    async fn mount_root(&self, path: &str, writable: bool) -> FsResult<Arc<dyn MountedFileSystem>> {
        // Each attachment has its own channel, while authentication and verified
        // host identity remain owned by the accepted connection.
        let service = self
            .connection
            .text_files()
            .await
            .map_err(|e| FsError::new(FsErrorKind::Offline, e.to_string()))?;
        Ok(crate::mounted::SftpMount::connected(
            Arc::new(service),
            path,
            writable,
            self.connection.clone(),
        )
        .await?)
    }
    async fn volumes(&self) -> Result<FileVolumes> {
        self.inventory().await
    }
    async fn set_volume_mounted(&self, id: &str, revision: &str, mounted: bool) -> Result<()> {
        let _guard = self.changes.lock().await;
        let current = self.inventory().await?;
        let volume = reviewed_volume(&current, id, revision, mounted)?;
        let command = mount_command(self.platform().await, volume, mounted)?;
        self.connection.exec_bounded(&command).await.context(
            "Volume change failed or could not be confirmed. Refresh the drives before retrying",
        )?;
        let after = self
            .inventory()
            .await
            .context("The command completed, but drive refresh failed. Refresh before retrying")?;
        let changed = after.volumes.iter().find(|v| v.id == id);
        if changed.is_none_or(|v| v.locations.is_empty() == mounted) {
            bail!("The command completed, but the requested mount state could not be confirmed. Refresh the drives before retrying");
        }
        Ok(())
    }
    async fn list(&self, path: Option<&str>) -> Result<Directory> {
        self.browser.list(path).await
    }
    async fn open_directory(
        self: Arc<Self>,
        path: Option<&str>,
    ) -> Result<Box<dyn DirectoryReader>> {
        self.browser.clone().open_directory(path).await
    }
    async fn locate(&self, path: &str) -> Result<FileLocation> {
        self.browser.locate(path).await
    }
    async fn preview(&self, path: &str) -> Result<String> {
        self.browser.preview(path).await
    }
}
fn reviewed_volume<'a>(
    snapshot: &'a FileVolumes,
    id: &str,
    revision: &str,
    mounted: bool,
) -> Result<&'a FileVolume> {
    if revision.is_empty() || revision != snapshot.revision {
        bail!("Drives changed since review. Refresh and select the volume again");
    }
    let volume = snapshot
        .volumes
        .iter()
        .find(|v| v.id == id)
        .context("The selected volume is no longer present")?;
    if volume.system
        || !(if mounted {
            volume.can_mount
        } else {
            volume.can_unmount
        })
    {
        bail!("This volume does not support the requested action");
    }
    Ok(volume)
}
fn mount_command(platform: Platform, volume: &FileVolume, mounted: bool) -> Result<String> {
    let verb = if mounted { "mount" } else { "unmount" };
    match platform {
        Platform::Linux => {
            let device = volume
                .id
                .strip_prefix("block:")
                .and_then(|s| s.split('|').next())
                .context("Invalid block device")?;
            if !device.starts_with("/dev/")
                || !device
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"/_-+.".contains(&b))
            {
                bail!("Invalid block device");
            }
            Ok(format!(
                "udisksctl {verb} --block-device '{device}' --no-user-interaction"
            ))
        }
        Platform::Mac => {
            let device = volume
                .id
                .strip_prefix("disk:")
                .and_then(|s| s.split('|').next())
                .context("Invalid disk identity")?;
            if !device.starts_with("disk") || !device.bytes().all(|b| b.is_ascii_alphanumeric()) {
                bail!("Invalid disk identity");
            }
            Ok(format!("diskutil {verb} '{device}'"))
        }
        _ => bail!("Mount controls are unavailable on this device"),
    }
}
fn inventory() -> FileVolumes {
    FileVolumes {
        revision: String::new(),
        volumes: vec![],
        notices: vec![],
    }
}
fn place(path: &str) -> FilePlace {
    FilePlace {
        path: path.into(),
        name: path.into(),
    }
}
fn string<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn protected(path: &str) -> bool {
    path == "/"
        || [
            "/boot", "/System", "/usr", "/var", "/etc", "/dev", "/proc", "/sys",
        ]
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
}
fn unescape_mount(value: &str) -> String {
    // Kernel mountinfo escapes exactly these bytes. Decode once, so a literal
    // backslash followed by digits cannot turn into a second escape sequence.
    let mut result = String::new();
    let mut rest = value;
    while !rest.is_empty() {
        let escape = [
            ("\\040", ' '),
            ("\\011", '\t'),
            ("\\012", '\n'),
            ("\\134", '\\'),
        ]
        .into_iter()
        .find(|(code, _)| rest.starts_with(code));
        if let Some((code, ch)) = escape {
            result.push(ch);
            rest = &rest[code.len()..];
        } else {
            let ch = rest.chars().next().unwrap();
            result.push(ch);
            rest = &rest[ch.len_utf8()..];
        }
    }
    result
}
fn linux_mounts(data: &str) -> Result<FileVolumes> {
    let mut result = inventory();
    for line in data.lines().filter(|l| !l.is_empty()) {
        let (left, right) = line
            .split_once(" - ")
            .context("Invalid Linux mount inventory")?;
        let fields: Vec<_> = left.split_whitespace().collect();
        let tail: Vec<_> = right.split_whitespace().collect();
        if fields.len() < 6 || tail.len() < 3 {
            bail!("Invalid Linux mount inventory");
        }
        let path = unescape_mount(fields[4]);
        let source = unescape_mount(tail[1]);
        let system = protected(&path)
            || [
                "proc",
                "sysfs",
                "devtmpfs",
                "devpts",
                "cgroup",
                "cgroup2",
                "securityfs",
                "debugfs",
                "tracefs",
                "pstore",
                "configfs",
                "mqueue",
                "hugetlbfs",
                "bpf",
            ]
            .contains(&tail[0]);
        result.volumes.push(FileVolume {
            id: format!("mount:{}:{}", fields[0], fields[2]),
            name: path.clone(),
            detail: format!("{source} · {}", tail[0]),
            locations: vec![place(&path)],
            system,
            can_mount: false,
            can_unmount: false,
        });
    }
    Ok(result)
}
fn linux_blocks(result: &mut FileVolumes, data: &Value, controls: bool) {
    fn visit(result: &mut FileVolumes, node: &Value, controls: bool) {
        let device = string(node, "name");
        let fs = string(node, "fstype");
        let label = string(node, "label");
        if device.starts_with("/dev/")
            && !fs.is_empty()
            && !["swap", "crypto_LUKS", "LVM2_member", "linux_raid_member"].contains(&fs)
        {
            let prefix = format!("{device} · ");
            let number = string(node, "maj:min");
            let matches = |volume: &FileVolume| {
                volume.detail.starts_with(&prefix)
                    || (!number.is_empty()
                        && volume.id.starts_with("mount:")
                        && volume.id.ends_with(&format!(":{number}")))
            };
            let matching: Vec<_> = result
                .volumes
                .iter()
                .filter(|v| matches(v))
                .cloned()
                .collect();
            let locations: Vec<_> = matching.iter().flat_map(|v| v.locations.clone()).collect();
            let system = matching.iter().any(|v| v.system);
            result.volumes.retain(|v| !matches(v));
            result.volumes.push(FileVolume {
                id: format!("block:{device}|{}", string(node, "uuid")),
                name: if label.is_empty() {
                    device.into()
                } else {
                    label.into()
                },
                detail: format!("{device} · {fs}"),
                can_mount: controls && !system && locations.is_empty(),
                can_unmount: controls && !system && locations.len() == 1,
                locations,
                system,
            });
        }
        if let Some(children) = node.get("children").and_then(Value::as_array) {
            for child in children {
                visit(result, child, controls);
            }
        }
    }
    if let Some(nodes) = data.get("blockdevices").and_then(Value::as_array) {
        for node in nodes {
            visit(result, node, controls);
        }
    }
    let mut seen = HashSet::new();
    result.volumes.retain(|v| seen.insert(v.id.clone()));
}
fn mac_volumes(data: &Value) -> FileVolumes {
    fn visit(result: &mut FileVolumes, node: &Value) {
        match node {
            Value::Array(items) => {
                for item in items {
                    visit(result, item);
                }
            }
            Value::Object(map) => {
                let device = string(node, "DeviceIdentifier");
                let name = string(node, "VolumeName");
                let path = string(node, "MountPoint");
                if !device.is_empty() && (!name.is_empty() || !path.is_empty()) {
                    let system =
                        protected(path) || matches!(name, "Preboot" | "Recovery" | "VM" | "Update");
                    result.volumes.push(FileVolume {
                        id: format!("disk:{device}|{}", string(node, "VolumeUUID")),
                        name: if name.is_empty() {
                            device.into()
                        } else {
                            name.into()
                        },
                        detail: format!("{device} · {}", string(node, "Content")),
                        locations: if path.is_empty() {
                            vec![]
                        } else {
                            vec![place(path)]
                        },
                        system,
                        can_mount: !system && path.is_empty(),
                        can_unmount: !system && !path.is_empty(),
                    });
                }
                for value in map.values().filter(|v| v.is_array() || v.is_object()) {
                    visit(result, value);
                }
            }
            _ => {}
        }
    }
    let mut result = inventory();
    visit(&mut result, data);
    let mut seen = HashSet::new();
    result.volumes.retain(|v| seen.insert(v.id.clone()));
    result
}
fn mac_mounts(result: &mut FileVolumes, data: &str) {
    for line in data.lines() {
        let Some((source, rest)) = line.split_once(" on ") else {
            continue;
        };
        let Some((path, flags)) = rest.rsplit_once(" (") else {
            continue;
        };
        if result
            .volumes
            .iter()
            .any(|v| v.locations.iter().any(|l| l.path == path))
        {
            continue;
        }
        result.volumes.push(FileVolume {
            id: format!("mount:{path}"),
            name: path.into(),
            detail: format!("{source} · {}", flags.trim_end_matches(')')),
            locations: vec![place(path)],
            system: protected(path),
            can_mount: false,
            can_unmount: false,
        });
    }
}
pub(crate) fn powershell(script: &str) -> String {
    let bytes: Vec<_> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!(
        "powershell.exe -NoProfile -NonInteractive -EncodedCommand {}",
        STANDARD.encode(bytes)
    )
}
const WINDOWS_VOLUMES: &str = r#"
$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new()
$v=@(); $notices=@()
try {
  $v=@(Get-Volume | ForEach-Object {
    $volume=$_; $paths=@()
    if ($volume.DriveLetter) { $paths+=([string]$volume.DriveLetter+':/') }
    $paths+=@($volume | Get-Partition -ErrorAction SilentlyContinue | ForEach-Object { $_.AccessPaths } | Where-Object { $_ -match '^[A-Za-z]:\\' } | ForEach-Object { $_.Replace('\','/') })
    @{id=$volume.UniqueId;name=$volume.FileSystemLabel;fs=$volume.FileSystem;paths=@($paths | Select-Object -Unique)}
  })
} catch { $notices+='Detailed storage discovery is unavailable. Showing accessible logical drives.' }
try {
  Get-CimInstance Win32_LogicalDisk | ForEach-Object {
    $path=$_.DeviceID+'/'
    if (-not ($v | Where-Object { $_.paths -contains $path })) {
      $v+=@{id=('logical:'+ $_.DeviceID);name=$_.VolumeName;fs=$_.FileSystem;paths=@($path)}
    }
  }
} catch { if ($v.Count -eq 0) { throw }; $notices+='Additional logical-drive discovery failed.' }
ConvertTo-Json -InputObject @{volumes=@($v);notices=@($notices)} -Depth 5 -Compress
"#;
const WINDOWS_LOGICAL_DRIVES: &str = r#"$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $v=@(Get-CimInstance Win32_LogicalDisk | ForEach-Object { @{id=('logical:'+ $_.DeviceID);name=$_.VolumeName;fs=$_.FileSystem;paths=@($_.DeviceID+'/')} }); ConvertTo-Json -InputObject @{volumes=$v;notices=@()} -Depth 5 -Compress"#;
fn windows_volumes(data: &Value) -> FileVolumes {
    let mut result = inventory();
    if let Some(notices) = data.get("notices").and_then(Value::as_array) {
        result
            .notices
            .extend(notices.iter().filter_map(Value::as_str).map(str::to_owned));
    }
    if let Some(nodes) = data.get("volumes").and_then(Value::as_array) {
        for node in nodes {
            let paths = node
                .get("paths")
                .and_then(Value::as_array)
                .map(|paths| {
                    paths
                        .iter()
                        .filter_map(Value::as_str)
                        .map(place)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let id = string(node, "id");
            if id.is_empty() {
                continue;
            }
            let name = string(node, "name");
            result.volumes.push(FileVolume {
                id: id.into(),
                name: if name.is_empty() {
                    paths
                        .first()
                        .map(|p| p.path.clone())
                        .unwrap_or_else(|| "Volume without an access path".into())
                } else {
                    name.into()
                },
                detail: string(node, "fs").into(),
                locations: paths,
                system: false,
                can_mount: false,
                can_unmount: false,
            });
        }
    }
    result.notices.push("Windows mount-point assignment is not available here yet. Drives and folder mount points are shown for the SSH account; other users' mapped drives may not be visible.".into());
    result
}

#[cfg(test)]
mod tests;
