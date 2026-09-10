// SPDX-License-Identifier: MPL-2.0
//! Desktop-owned root grants. Drivers and filesystem callbacks live in the bridge.
use crate::{connection_resource::ConnectionLease, DesktopState};
use serde::Serialize;
use shellcanvas_services::{
    bridge_control::{BridgeControl, BridgePhase, BridgeSnapshot},
    wire::Server,
    ConnectionIdentity, FileSystemProvider,
};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Manager, State};
use tokio::{io::AsyncReadExt, process::Command};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingInfo {
    pub id: String,
    pub session_id: u64,
    pub source: ConnectionIdentity,
    pub remote_path: String,
    pub host_label: String,
    pub local_path: String,
    pub writable: bool,
    pub status: BridgeSnapshot,
    pub running: bool,
    pub cleanup_warning: Option<String>,
}
struct Mapping {
    info: MappingInfo,
    control: Arc<BridgeControl>,
    _lease: Option<ConnectionLease>,
}
#[derive(Clone, Default)]
pub struct Mappings(Arc<Mutex<BTreeMap<String, Mapping>>>);
impl Mappings {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, BTreeMap<String, Mapping>>, String> {
        self.0
            .lock()
            .map_err(|_| "Attachment state unavailable".into())
    }
    pub fn list(&self) -> Result<Vec<MappingInfo>, String> {
        self.lock()?
            .values()
            .map(|m| {
                let mut info = m.info.clone();
                info.status = m.control.snapshot().map_err(|e| e.to_string())?;
                Ok(info)
            })
            .collect()
    }
    pub fn ensure_releasable(
        &self,
        session: u64,
        source: Option<&ConnectionIdentity>,
    ) -> Result<(), String> {
        if self.lock()?.values().any(|m| {
            m.info.running
                && m.info.session_id == session
                && source.is_none_or(|s| s == &m.info.source)
        }) {
            return Err("Detach this host's local drives in Settings → Files before disconnecting or replacing its file connection.".into());
        }
        Ok(())
    }
    pub fn has_running(&self) -> bool {
        self.lock()
            .map(|items| items.values().any(|m| m.info.running))
            .unwrap_or(true)
    }
    fn reserve(
        &self,
        info: MappingInfo,
        control: Arc<BridgeControl>,
        lease: Option<ConnectionLease>,
    ) -> Result<(), String> {
        let mut items = self.lock()?;
        if items
            .values()
            .any(|m| m.info.running && m.info.local_path == info.local_path)
        {
            return Err("That local location already has an attachment.".into());
        }
        items.insert(
            info.id.clone(),
            Mapping {
                info,
                control,
                _lease: lease,
            },
        );
        Ok(())
    }
    fn finished(&self, id: &str) {
        if let Ok(mut items) = self.lock() {
            if let Some(item) = items.get_mut(id) {
                item.info.running = false;
                item._lease = None;
            }
        }
    }
    fn detach(&self, id: &str) -> Result<(), String> {
        let items = self.lock()?;
        let mapping = items.get(id).ok_or("Attachment no longer exists")?;
        mapping.control.request_detach().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn drive_mappings(state: State<'_, DesktopState>) -> Result<Vec<MappingInfo>, String> {
    state.mappings.list()
}
#[tauri::command]
pub fn detach_drive(id: String, state: State<'_, DesktopState>) -> Result<(), String> {
    state.mappings.detach(&id)
}
#[tauri::command]
pub fn dismiss_drive(id: String, state: State<'_, DesktopState>) -> Result<(), String> {
    let mut items = state.mappings.lock()?;
    if items.get(&id).is_some_and(|item| item.info.running) {
        return Err("Detach the drive before dismissing it.".into());
    }
    items.remove(&id);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    pub supported: bool,
    pub installed: bool,
    pub windows: bool,
}
#[tauri::command]
pub async fn drive_mapping_available(
    session_id: u64,
    binding: ConnectionIdentity,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<Availability, String> {
    let files = crate::filesystem(&state, session_id, Some(&binding)).await?;
    let supported = files.supports_local_mount();
    let storage = crate::profile_store::storage_dir(&app)?;
    let installed = tauri::async_runtime::spawn_blocking(move || {
        crate::drive_bridge_install::installed(&storage)
    })
    .await
    .map_err(|e| e.to_string())??
    .is_some();
    Ok(Availability {
        supported,
        installed,
        windows: cfg!(windows),
    })
}

fn windows_target(value: &str) -> Result<PathBuf, String> {
    let bytes = value.as_bytes();
    if bytes.len() != 2 || !bytes[0].is_ascii_uppercase() || bytes[1] != b':' || bytes[0] < b'D' {
        return Err("Choose a drive letter from D: to Z:.".into());
    }
    Ok(PathBuf::from(value))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri injects the window/state beside the scoped user request.
pub async fn attach_drive(
    session_id: u64,
    binding: ConnectionIdentity,
    path: String,
    writable: bool,
    drive: Option<String>,
    host_label: Option<String>,
    window: tauri::WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<Option<String>, String> {
    let app = window.app_handle().clone();
    let storage = crate::profile_store::storage_dir(&app)?;
    let installation = tauri::async_runtime::spawn_blocking(move || {
        crate::drive_bridge_install::installed(&storage)
    })
    .await
    .map_err(|e| e.to_string())??
    .ok_or("Install Drive Bridge in Settings → Files first.")?;
    let target = if cfg!(windows) {
        windows_target(drive.as_deref().ok_or("Choose a drive letter")?)?
    } else {
        use tauri_plugin_dialog::DialogExt;
        let selected = tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .set_title("Choose an empty local folder for the attachment")
                .blocking_pick_folder()
        })
        .await
        .map_err(|e| e.to_string())?;
        let Some(selected) = selected else {
            return Ok(None);
        };
        let selected = selected.into_path().map_err(|_| "Choose a local folder")?;
        tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
            let target = selected.canonicalize().map_err(|e| e.to_string())?;
            if target
                .read_dir()
                .map_err(|e| e.to_string())?
                .next()
                .is_some()
            {
                return Err(
                    "Choose an empty folder so existing local files are not hidden.".into(),
                );
            }
            Ok(target)
        })
        .await
        .map_err(|e| e.to_string())??
    };
    // Reserve while holding the registry lock: disconnect/replacement use the same
    // order and cannot retire this source between validation and grant ownership.
    let _transition = state.mount_transition.lock().await;
    let registry = state.registry.lock().await;
    let session = registry
        .sessions
        .get(&session_id)
        .ok_or("Workspace is closed")?;
    session.check_source(&crate::ServiceRole::Files, Some(&binding))?;
    let files = session
        .files
        .clone()
        .ok_or("This host has no file access")?;
    if !files.supports_local_mount() {
        return Err("This file provider does not support local attachments.".into());
    }
    let connection = session
        .service_connection(&crate::ServiceRole::Files)
        .ok_or("File connection unavailable")?;
    let lease = connection.lease()?;
    let id = uuid::Uuid::new_v4().to_string();
    let control = Arc::new(BridgeControl::default());
    let info = MappingInfo {
        id: id.clone(),
        session_id,
        source: binding,
        remote_path: path.clone(),
        host_label: host_label
            .filter(|label| !label.trim().is_empty())
            .unwrap_or_else(|| format!("Workspace {session_id}"))
            .chars()
            .take(256)
            .collect(),
        local_path: target.to_string_lossy().into_owned(),
        writable,
        status: control.snapshot().map_err(|e| e.to_string())?,
        running: true,
        cleanup_warning: None,
    };
    state.mappings.reserve(info, control.clone(), Some(lease))?;
    let mappings = state.mappings.clone();
    let task_id = id.clone();
    // A canceled UI invocation does not drop a live mapping or its connection lease.
    tauri::async_runtime::spawn(async move {
        let safe = Arc::new(AtomicBool::new(true));
        let result = run(
            installation,
            target,
            files,
            path,
            writable,
            control.clone(),
            safe.clone(),
        )
        .await;
        if let Err(error) = result {
            control.fail(error.clone());
            if !safe.load(Ordering::Acquire) {
                if let Ok(mut items) = mappings.lock() {
                    if let Some(item) = items.get_mut(&task_id) {
                        item.info.cleanup_warning = Some(error);
                    }
                }
            }
        }
        if safe.load(Ordering::Acquire) {
            mappings.finished(&task_id);
        }
    });
    Ok(Some(id))
}

async fn run(
    installation: (crate::drive_bridge_install::Installation, PathBuf),
    target: PathBuf,
    files: Arc<dyn FileSystemProvider>,
    path: String,
    writable: bool,
    control: Arc<BridgeControl>,
    safe: Arc<AtomicBool>,
) -> Result<(), String> {
    let root = tokio::time::timeout(Duration::from_secs(30), files.mount_root(&path, writable))
        .await
        .map_err(|_| "Opening the attachment root timed out")?
        .map_err(|e| e.to_string())?;
    if writable && !root.capabilities().writable {
        return Err("This file provider permits only read-only attachments. Choose Read only and try again.".into());
    }
    let executable = tauri::async_runtime::spawn_blocking(move || {
        crate::drive_bridge_install::verify(&installation.1, &installation.0)?;
        Ok::<_, String>(installation.1)
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut command = Command::new(executable);
    command.arg("--mount").arg(target);
    supervise(command, root, control, safe, Duration::from_secs(30)).await
}

async fn supervise(
    mut command: Command,
    root: Arc<dyn shellcanvas_services::MountedFileSystem>,
    control: Arc<BridgeControl>,
    safe: Arc<AtomicBool>,
    startup_timeout: Duration,
) -> Result<(), String> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let (mut child, tree) = shellcanvas_adapter_runtime::ProcessTree::spawn(&mut command)
        .await
        .map_err(|e| e.to_string())?;
    safe.store(false, Ordering::Release);
    let reader = child
        .stdout
        .take()
        .ok_or("Bridge output pipe unavailable")?;
    let writer = child.stdin.take().ok_or("Bridge input pipe unavailable")?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or("Bridge diagnostic pipe unavailable")?;
    let diagnostics = Arc::new(Mutex::new(Vec::new()));
    let tail = diagnostics.clone();
    let drain = tokio::spawn(async move {
        let mut chunk = [0u8; 1024];
        while let Ok(count) = stderr.read(&mut chunk).await {
            if count == 0 {
                break;
            }
            if let Ok(mut bytes) = tail.lock() {
                bytes.extend_from_slice(&chunk[..count]);
                let excess = bytes.len().saturating_sub(8192);
                bytes.drain(..excess);
            }
        }
    });
    let mut server =
        tokio::spawn(Server::with_control(root, control.clone()).serve(reader, writer));
    let start = tokio::time::Instant::now();
    let mut interval = tokio::time::interval(Duration::from_millis(250));
    let mut server_done = false;
    let result = loop {
        tokio::select! {
            status = child.wait() => {
                break match status {
                    Ok(status) if status.success() && control.snapshot().is_ok_and(|s| s.phase == BridgePhase::Detached) => Ok(()),
                    Ok(status) => Err(format!("Drive Bridge exited ({status}). {}", diagnostic_tail(&diagnostics))),
                    Err(e) => Err(e.to_string()),
                };
            }
            result = &mut server => {
                server_done = true;
                if control.snapshot().is_ok_and(|s| s.phase == BridgePhase::Detached) { break Ok(()); }
                break Err(format!("Attachment transport ended: {result:?}. {}", diagnostic_tail(&diagnostics)));
            }
            _ = interval.tick() => {
                if start.elapsed() > startup_timeout && control.snapshot().is_ok_and(|s| s.phase == BridgePhase::Starting) {
                    break Err(format!("Drive Bridge did not attach within 30 seconds. {}", diagnostic_tail(&diagnostics)));
                }
            }
        }
    };
    // User detach only arrives here after the native backend confirms unmount.
    // A crashed/stalled startup or broken transport is failure, never a busy retry.
    let cleanup = tokio::time::timeout(Duration::from_secs(10), tree.cleanup(&mut child)).await;
    if !server_done
        && tokio::time::timeout(Duration::from_secs(35), &mut server)
            .await
            .is_err()
    {
        server.abort();
    }
    drain.abort();
    match cleanup {
        Ok(Ok(())) => { safe.store(true, Ordering::Release); result },
        _ => Err("Attachment process cleanup is unconfirmed. Check the local mount before using that location again.".into()),
    }
}
fn diagnostic_tail(bytes: &Mutex<Vec<u8>>) -> String {
    bytes
        .lock()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use shellcanvas_services::*;

    struct EmptyRoot;
    fn unsupported<T>() -> FsResult<T> {
        Err(FsError::new(
            FsErrorKind::Unsupported,
            "Fixture has no files",
        ))
    }
    #[async_trait::async_trait]
    impl MountedFileSystem for EmptyRoot {
        fn capabilities(&self) -> FsCapabilities {
            FsCapabilities {
                writable: false,
                atomic_replace: false,
                durable_flush: false,
            }
        }
        async fn metadata(&self, _: &MountPath) -> FsResult<FsMetadata> {
            unsupported()
        }
        async fn open(&self, _: &MountPath, _: FsOpenOptions) -> FsResult<Arc<dyn MountedFile>> {
            unsupported()
        }
        async fn open_directory(&self, _: &MountPath) -> FsResult<Box<dyn MountedDirectory>> {
            unsupported()
        }
        async fn set_metadata(&self, _: &MountPath, _: FsSetMetadata) -> FsResult<()> {
            unsupported()
        }
        async fn mkdir(&self, _: &MountPath) -> FsResult<()> {
            unsupported()
        }
        async fn remove(&self, _: &MountPath, _: bool) -> FsResult<()> {
            unsupported()
        }
        async fn rename(&self, _: &MountPath, _: &MountPath, _: bool) -> FsResult<()> {
            unsupported()
        }
    }
    #[tokio::test]
    #[ignore = "Build lifecycle_fixture, set SHELLCANVAS_BRIDGE_FIXTURE to its absolute executable, then run explicitly. No driver or remote I/O."]
    async fn native_helper_supervision_bounds_failures_and_preserves_busy_detach() {
        let fixture = PathBuf::from(
            std::env::var_os("SHELLCANVAS_BRIDGE_FIXTURE").expect("Fixture executable is required"),
        );
        assert!(fixture.is_absolute() && fixture.is_file());
        for mode in ["stall", "invalid"] {
            let control = Arc::new(BridgeControl::default());
            let safe = Arc::new(AtomicBool::new(true));
            let mut command = Command::new(&fixture);
            command.arg(mode);
            let result = tokio::time::timeout(
                Duration::from_secs(12),
                supervise(
                    command,
                    Arc::new(EmptyRoot),
                    control,
                    safe.clone(),
                    Duration::from_millis(500),
                ),
            )
            .await
            .unwrap();
            assert!(result.is_err(), "{mode}");
            assert!(
                safe.load(Ordering::Acquire),
                "{mode} process was not reaped"
            );
        }
        let control = Arc::new(BridgeControl::default());
        let safe = Arc::new(AtomicBool::new(true));
        let mut command = Command::new(fixture);
        command.arg("busy");
        let task = tokio::spawn(supervise(
            command,
            Arc::new(EmptyRoot),
            control.clone(),
            safe.clone(),
            Duration::from_secs(5),
        ));
        async fn phase(control: &BridgeControl, expected: BridgePhase) {
            tokio::time::timeout(Duration::from_secs(5), async {
                while control.snapshot().unwrap().phase != expected {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
        }
        phase(&control, BridgePhase::Attached).await;
        assert!(!safe.load(Ordering::Acquire));
        control.request_detach().unwrap();
        phase(&control, BridgePhase::Attached).await;
        assert_eq!(
            control.snapshot().unwrap().message.as_deref(),
            Some("Fixture file is busy")
        );
        assert!(!task.is_finished(), "Busy detach killed the helper");
        control.request_detach().unwrap();
        tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(safe.load(Ordering::Acquire));
        assert_eq!(control.snapshot().unwrap().phase, BridgePhase::Detached);
    }

    #[tokio::test]
    async fn mapping_lease_survives_workspace_owner_until_native_cleanup() {
        struct Connected(AtomicBool);
        #[async_trait::async_trait]
        impl ConnectionLifecycle for Connected {
            fn is_connected(&self) -> bool {
                self.0.load(Ordering::Acquire)
            }
            async fn disconnect(&self) -> anyhow::Result<()> {
                self.0.store(false, Ordering::Release);
                Ok(())
            }
        }
        let source = ConnectionIdentity {
            instance: 1,
            generation: 1,
            adapter: "fixture".into(),
        };
        let resource = crate::connection_resource::ConnectionResource::new(
            source.clone(),
            Arc::new(Connected(AtomicBool::new(true))),
        );
        let workspace = resource.lease().unwrap();
        let mappings = Mappings::default();
        let control = Arc::new(BridgeControl::default());
        mappings
            .reserve(
                MappingInfo {
                    id: "lease".into(),
                    session_id: 1,
                    source,
                    remote_path: "/".into(),
                    host_label: "Fixture".into(),
                    local_path: "Z:".into(),
                    writable: false,
                    status: control.snapshot().unwrap(),
                    running: true,
                    cleanup_warning: None,
                },
                control,
                Some(resource.lease().unwrap()),
            )
            .unwrap();
        drop(workspace);
        assert!(resource.is_connected());
        mappings.finished("lease");
        tokio::time::timeout(Duration::from_secs(1), async {
            while resource.is_connected() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    #[test]
    fn reservations_protect_only_their_source_and_outlive_detach_until_reaped() {
        let mappings = Mappings::default();
        let control = Arc::new(BridgeControl::default());
        let source = ConnectionIdentity {
            instance: 1,
            generation: 2,
            adapter: "fixture".into(),
        };
        let info = MappingInfo {
            id: "a".into(),
            session_id: 7,
            source: source.clone(),
            remote_path: "/data".into(),
            host_label: "Fixture host".into(),
            local_path: "Z:".into(),
            writable: false,
            status: control.snapshot().unwrap(),
            running: true,
            cleanup_warning: None,
        };
        mappings
            .reserve(info.clone(), control.clone(), None)
            .unwrap();
        assert!(mappings.ensure_releasable(7, None).is_err());
        assert!(mappings.ensure_releasable(8, None).is_ok());
        let other = ConnectionIdentity {
            generation: 3,
            ..source.clone()
        };
        assert!(mappings.ensure_releasable(7, Some(&other)).is_ok());
        assert!(mappings.reserve(info, control.clone(), None).is_err());
        control
            .report(shellcanvas_services::bridge_control::BridgeEvent::Ready)
            .unwrap();
        mappings.detach("a").unwrap();
        control
            .report(shellcanvas_services::bridge_control::BridgeEvent::Detached)
            .unwrap();
        assert!(mappings.ensure_releasable(7, Some(&source)).is_err());
        mappings.finished("a");
        assert!(mappings.ensure_releasable(7, None).is_ok());
    }
    #[test]
    fn drive_targets_do_not_accept_paths_or_shell_arguments() {
        assert_eq!(windows_target("Z:").unwrap(), PathBuf::from("Z:"));
        for invalid in ["C:", "z:", "Z:\\folder", "../other", "Z: --option"] {
            assert!(windows_target(invalid).is_err());
        }
    }
}
