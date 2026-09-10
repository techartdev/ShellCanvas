// SPDX-License-Identifier: MPL-2.0
use serde::Serialize;
use shellcanvas_core::*;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tauri::{ipc::Channel, Manager, State};
use tokio::sync::{mpsc, Mutex};
mod adapter_diagnostics;
mod adapters;
mod app_network;
mod builtin_ssh;
#[cfg(any(windows, test))]
mod clipboard_move;
#[cfg(windows)]
mod clipboard_stream;
mod connection_attempts;
mod connection_resource;
mod custom_binding;
mod custom_services;
mod directories;
mod drive_bridge_install;
mod drive_mappings;
mod drive_recovery;
mod local_mounts;
mod extension_frames;
#[cfg(debug_assertions)]
mod extension_probe;
mod host_trust;
mod native_ipc;
mod prepared_source;
mod profile_store;
mod repository_install;
#[cfg(test)]
mod request_source_tests;
mod session_registry;
mod terminals;
mod transfers;
#[cfg(windows)]
mod windows_clipboard;
#[cfg(windows)]
mod windows_file_input;
mod workspace_profiles;
mod workspace_services;
use connection_resource::ConnectionResource;
use session_registry::SessionRegistry;
use workspace_services::ServiceRole;
use workspace_services::WorkspaceServices as ActiveSession;
#[derive(Default)]
struct DesktopState {
    mappings: drive_mappings::Mappings,
    mount_transition: Mutex<()>,
    directories: directories::DirectoryReaders,
    registry: Arc<Mutex<SessionRegistry<ActiveSession>>>,
    next_id: AtomicU64,
    attempts: Mutex<connection_attempts::ConnectionAttempts>,
    transfers: Mutex<transfers::TransferRegistry>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    source_revision: u64,
    id: u64,
    info: HostInfo,
    connections: Vec<ConnectionIdentity>,
    services: Vec<workspace_services::ServiceStatus>,
    custom_sources: std::collections::BTreeMap<String, ConnectionIdentity>,
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Client compile target, independent of all remote workspace connections.
#[tauri::command]
fn client_platform() -> &'static str {
    std::env::consts::OS
}

#[tauri::command]
async fn profiles(app: tauri::AppHandle) -> Result<Vec<HostProfile>, String> {
    let dir = profile_store::storage_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut saved = profile_store::list(&dir)?;
        saved.extend(local_profiles());
        Ok(saved)
    })
    .await
    .map_err(error)?
}
#[tauri::command]
async fn save_profile(app: tauri::AppHandle, profile: HostProfile) -> Result<HostProfile, String> {
    let dir = profile_store::storage_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || profile_store::save(&dir, profile))
        .await
        .map_err(error)?
}
#[tauri::command]
async fn remove_profile(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dir = profile_store::storage_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || profile_store::remove(&dir, &id))
        .await
        .map_err(error)?
}

#[tauri::command]
async fn begin_connect(state: State<'_, DesktopState>) -> Result<u64, String> {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    state.attempts.lock().await.begin(id)?;
    Ok(id)
}
#[tauri::command]
async fn cancel_connect(request_id: u64, state: State<'_, DesktopState>) -> Result<(), String> {
    state.attempts.lock().await.cancel(request_id);
    Ok(())
}
#[tauri::command]
async fn connect(
    options: ConnectOptions,
    request_id: u64,
    on_host_key: Channel<connection_attempts::HostKeyChallenge>,
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<SessionInfo, String> {
    let canceled = state.attempts.lock().await.claim(request_id)?;
    let result = connection_attempts::cancellable(
        canceled,
        connect_session(options, request_id, on_host_key, app, &state),
    )
    .await;
    state.attempts.lock().await.finish(request_id);
    result
}
async fn connect_session(
    options: ConnectOptions,
    request_id: u64,
    on_host_key: Channel<connection_attempts::HostKeyChallenge>,
    app: tauri::AppHandle,
    state: &DesktopState,
) -> Result<SessionInfo, String> {
    let source = prepare_ssh(options, request_id, on_host_key, app, state).await?;
    let info = source.info.clone();
    let bindings = [
        ("files".into(), "ssh".into()),
        ("console".into(), "ssh".into()),
        ("host.settings".into(), "ssh".into()),
    ]
    .into();
    let (active, _) = prepared_source::compose(
        vec![("ssh".into(), source)],
        &bindings,
        info.hostname.clone(),
    )?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let status = active.status();
    let connections = active.identities();
    state.registry.lock().await.sessions.insert(id, active);
    Ok(SessionInfo {
        id,
        info,
        source_revision: status.source_revision,
        connections,
        services: status.services,
        custom_sources: status.custom_sources,
    })
}
async fn prepare_ssh(
    options: ConnectOptions,
    request_id: u64,
    on_host_key: Channel<connection_attempts::HostKeyChallenge>,
    app: tauri::AppHandle,
    state: &DesktopState,
) -> Result<prepared_source::PreparedSource, String> {
    let trust_dir = profile_store::storage_dir(&app)?;
    let trust_path = host_trust::store_path(&trust_dir);
    let connection = match Connection::connect_with_trust_store(&options, trust_path.clone()).await
    {
        Ok(connection) => connection,
        Err(connect_error) => {
            let candidate = connect_error
                .downcast_ref::<UnknownHostKey>()
                .cloned()
                .ok_or_else(|| format!("{connect_error:#}"))?;
            let (challenge, decision) =
                state.attempts.lock().await.review(request_id, &candidate)?;
            on_host_key
                .send(challenge)
                .map_err(|_| "Cannot display the host-key review")?;
            let approved = tokio::time::timeout(connection_attempts::REVIEW_TIMEOUT, decision)
                .await
                .map_err(|_| "Host-key review expired. Connect again to check the current key.")?
                .map_err(|_| "Host-key review canceled")?;
            if !approved {
                return Err("Host key was not trusted. No authentication was sent.".into());
            }
            let user_known_hosts = user_known_hosts_path().map_err(error)?;
            let approved_key = candidate.key.clone();
            tauri::async_runtime::spawn_blocking(move || {
                host_trust::remember(&trust_dir, &user_known_hosts, &candidate)
            })
            .await
            .map_err(error)?
            .map_err(|e| format!("{e:#}"))?;
            // One review only. A different key on this new connection is a hard
            // failure, not another prompt; authentication still follows verification.
            Connection::connect_with_approved_key(&options, trust_path, approved_key)
                .await
                .map_err(|e| format!("{e:#}"))?
        }
    };
    let connection = Arc::new(connection);
    let mut info = inspect_host(&connection).await;
    let settings = settings_for_host(&info.provider, Some(connection.clone()));
    if settings.is_some() {
        info.capabilities.push("host.settings".into());
    }
    let mut files: Option<Arc<dyn FileSystemProvider>> = None;
    let mut mutations: Option<Arc<dyn FileMutationService>> = None;
    let mut moves: Option<Arc<dyn FileMoveService>> = None;
    let mut transfers: Option<Arc<dyn FileTransferService>> = None;
    let text: Option<Arc<dyn TextFileService>> = match connection.text_files().await {
        Ok(service) => {
            if service.can_save() {
                info.capabilities.push("files.edit".into());
            }
            let service = Arc::new(service);
            let browser = Arc::new(SftpBrowser(service.clone()));
            info.home = browser.canonicalize(".").await.ok();
            files = Some(Arc::new(SshFileBrowser::new(browser, connection.clone())));
            info.capabilities.push("files.read".into());
            mutations = Some(service.clone());
            moves = Some(service.clone());
            transfers = Some(service.clone());
            info.capabilities.extend([
                "files.manage".into(),
                "files.move".into(),
                "files.create".into(),
                "files.upload".into(),
                "files.download".into(),
                "files.copy".into(),
                "files.folders".into(),
            ]);
            Some(service)
        }
        Err(error) => {
            info.notices
                .push(format!("File access unavailable: {error}"));
            None
        }
    };
    let resource = ConnectionResource::new(
        ConnectionIdentity {
            instance: state.next_id.fetch_add(1, Ordering::Relaxed) + 1,
            generation: 1,
            adapter: "ssh".into(),
        },
        connection.clone(),
    );
    let mut source = prepared_source::PreparedSource::new(resource, info)?;
    source.terminal = Some(connection);
    source.files = files;
    source.text = text;
    source.mutations = mutations;
    source.moves = moves;
    source.transfers = transfers;
    source.settings = settings;
    Ok(source)
}

#[tauri::command]
async fn decide_host_key(
    request_id: u64,
    token: String,
    approve: bool,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    state
        .attempts
        .lock()
        .await
        .decide(request_id, &token, approve)
}
#[tauri::command]
async fn disconnect(session_id: u64, state: State<'_, DesktopState>) -> Result<(), String> {
    let removed = {
        let mut registry = state.registry.lock().await;
        state.mappings.ensure_releasable(session_id, None)?;
        registry.remove(session_id)
    };
    state.transfers.lock().await.close_session(session_id);
    state.directories.close_session(session_id);
    if let Some(old) = removed {
        old.disconnect().await?;
    }
    Ok(())
}

#[tauri::command]
async fn session_alive(session_id: u64, state: State<'_, DesktopState>) -> Result<bool, String> {
    Ok(state
        .registry
        .lock()
        .await
        .sessions
        .get(&session_id)
        .is_some_and(|s| s.is_connected()))
}

#[tauri::command]
async fn session_status(
    session_id: u64,
    state: State<'_, DesktopState>,
) -> Result<Option<workspace_services::WorkspaceStatus>, String> {
    Ok(state
        .registry
        .lock()
        .await
        .sessions
        .get(&session_id)
        .map(|session| session.status()))
}

async fn filesystem(
    state: &DesktopState,
    session_id: u64,
    binding: Option<&ConnectionIdentity>,
) -> Result<Arc<dyn FileSystemProvider>, String> {
    session_service(state, session_id, binding, ServiceRole::Files, |s| {
        s.files.clone()
    })
    .await
}

async fn session_service<T: ?Sized>(
    state: &DesktopState,
    session_id: u64,
    binding: Option<&ConnectionIdentity>,
    role: ServiceRole,
    select: fn(&ActiveSession) -> Option<Arc<T>>,
) -> Result<Arc<T>, String> {
    let guard = state.registry.lock().await;
    let active = guard
        .sessions
        .get(&session_id)
        .ok_or("This host session is no longer connected")?;
    active.check_source(&role, binding)?;
    select(active).ok_or_else(|| format!("{role:?} service is unavailable in this workspace"))
}

async fn host_settings(
    state: &DesktopState,
    session_id: u64,
    binding: Option<&ConnectionIdentity>,
) -> Result<Arc<dyn HostSettingsService>, String> {
    session_service(state, session_id, binding, ServiceRole::HostSettings, |s| {
        s.settings.clone()
    })
    .await
}
#[tauri::command]
async fn read_host_settings(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    state: State<'_, DesktopState>,
) -> Result<Vec<HostSetting>, String> {
    host_settings(&state, session_id, binding.as_ref())
        .await?
        .read()
        .await
        .map_err(|error| format!("{error:#}"))
}
#[tauri::command]
async fn apply_host_setting(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    id: String,
    value: String,
    revision: String,
    state: State<'_, DesktopState>,
) -> Result<HostSetting, String> {
    host_settings(&state, session_id, binding.as_ref())
        .await?
        .apply(&id, &value, &revision)
        .await
        .map_err(|error| format!("{error:#}"))
}
#[tauri::command]
async fn list_directory(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    path: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<Directory, String> {
    filesystem(&state, session_id, binding.as_ref())
        .await?
        .list(path.as_deref())
        .await
        .map_err(|e| format!("{e:#}"))
}
#[tauri::command]
async fn file_volumes(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    state: State<'_, DesktopState>,
) -> Result<FileVolumes, String> {
    filesystem(&state, session_id, binding.as_ref())
        .await?
        .volumes()
        .await
        .map_err(error)
}

#[tauri::command]
async fn set_volume_mounted(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    id: String,
    revision: String,
    mounted: bool,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let _transition = state.mount_transition.lock().await;
    if !mounted {
        state.mappings.ensure_releasable(session_id, binding.as_ref()).map_err(|_| {
            "Detach this host's local drives in Settings → Files before unmounting a remote volume.".to_string()
        })?;
    }
    filesystem(&state, session_id, binding.as_ref())
        .await?
        .set_volume_mounted(&id, &revision, mounted)
        .await
        .map_err(error)
}

#[tauri::command]
async fn preview_file(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    path: String,
    state: State<'_, DesktopState>,
) -> Result<String, String> {
    filesystem(&state, session_id, binding.as_ref())
        .await?
        .preview(&path)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn read_text(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    path: String,
    state: State<'_, DesktopState>,
) -> Result<TextDocument, String> {
    let text = {
        let registry = state.registry.lock().await;
        let active = registry
            .sessions
            .get(&session_id)
            .ok_or("This host session is no longer connected")?;
        active.check_source(&ServiceRole::Files, binding.as_ref())?;
        active.text.clone()
    };
    if let Some(service) = text {
        return service.read_text(&path).await.map_err(|e| format!("{e:#}"));
    }
    let files = filesystem(&state, session_id, binding.as_ref()).await?;
    let location = files.locate(&path).await.map_err(error)?;
    let text = files.preview(&location.path).await.map_err(error)?;
    Ok(TextDocument {
        path: location.path,
        name: location.name,
        parent: location.parent,
        revision: text_revision(text.as_bytes()),
        text,
        writable: false,
    })
}
#[tauri::command]
async fn save_text(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    path: String,
    text: String,
    revision: String,
    state: State<'_, DesktopState>,
) -> Result<TextDocument, String> {
    let service = session_service(
        &state,
        session_id,
        binding.as_ref(),
        ServiceRole::Files,
        |s| s.text.clone(),
    )
    .await?;
    service
        .save_text(&path, &text, &revision)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn create_text(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    parent: String,
    name: String,
    text: String,
    state: State<'_, DesktopState>,
) -> Result<TextDocument, String> {
    let service = session_service(
        &state,
        session_id,
        binding.as_ref(),
        ServiceRole::Files,
        |s| s.text.clone(),
    )
    .await?;
    service
        .create_text(&parent, &name, &text)
        .await
        .map_err(|e| format!("{e:#}"))
}
async fn file_mutations(
    state: &DesktopState,
    session_id: u64,
    binding: Option<&ConnectionIdentity>,
) -> Result<Arc<dyn FileMutationService>, String> {
    session_service(state, session_id, binding, ServiceRole::Files, |s| {
        s.mutations.clone()
    })
    .await
}
#[tauri::command]
async fn make_directory(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    parent: String,
    name: String,
    state: State<'_, DesktopState>,
) -> Result<String, String> {
    file_mutations(&state, session_id, binding.as_ref())
        .await?
        .make_directory(&parent, &name)
        .await
        .map_err(|e| format!("{e:#}"))
}
#[tauri::command]
async fn rename_entry(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    path: String,
    name: String,
    revision: String,
    tracked: Vec<String>,
    state: State<'_, DesktopState>,
) -> Result<FileRelocation, String> {
    file_mutations(&state, session_id, binding.as_ref())
        .await?
        .rename_tracked(&path, &name, &revision, &tracked)
        .await
        .map_err(|e| format!("{e:#}"))
}
#[tauri::command]
async fn move_entry(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    path: String,
    parent: String,
    revision: String,
    tracked: Vec<String>,
    state: State<'_, DesktopState>,
) -> Result<FileRelocation, String> {
    let service = session_service(
        &state,
        session_id,
        binding.as_ref(),
        ServiceRole::Files,
        |s| s.moves.clone(),
    )
    .await?;
    service
        .move_tracked(&path, &parent, &revision, &tracked)
        .await
        .map_err(|e| format!("{e:#}"))
}
#[tauri::command]
async fn remove_entry(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    path: String,
    revision: String,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    file_mutations(&state, session_id, binding.as_ref())
        .await?
        .remove_entry(&path, &revision)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[derive(serde::Serialize)]
struct OpenedTerminal {
    id: u64,
    resizable: bool,
}
#[derive(Clone, serde::Serialize)]
struct TerminalDelivery {
    #[serde(flatten)]
    event: TerminalEvent,
    sequence: Option<u64>,
}
#[tauri::command]
async fn open_terminal(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    cols: u32,
    rows: u32,
    on_event: Channel<TerminalDelivery>,
    state: State<'_, DesktopState>,
) -> Result<OpenedTerminal, String> {
    let terminal = session_service(
        &state,
        session_id,
        binding.as_ref(),
        ServiceRole::Console,
        |s| s.terminal.clone(),
    )
    .await?;
    let stream = tokio::time::timeout(OP_TIMEOUT, terminal.open(TerminalSize::new(cols, rows)))
        .await
        .map_err(error)?
        .map_err(error)?;
    let (send, recv) = mpsc::channel(128);
    let resizable = stream.resizable;
    let gate = Arc::new(terminals::OutputGate::default());
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let canceled =
        state
            .registry
            .lock()
            .await
            .add_terminal(session_id, id, send, Some(gate.clone()))?;
    let registry = state.registry.clone();
    tauri::async_runtime::spawn(async move {
        terminals::run_terminal(stream, recv, canceled, |event| {
            let gate = gate.clone();
            let on_event = on_event.clone();
            async move {
                let sequence = matches!(&event, TerminalEvent::Output(_)).then(|| gate.begin());
                if on_event.send(TerminalDelivery { event, sequence }).is_err() {
                    return false;
                }
                if sequence.is_some() {
                    gate.wait().await;
                }
                true
            }
        })
        .await;
        registry.lock().await.close_terminal(session_id, id);
    });
    Ok(OpenedTerminal { id, resizable })
}

#[tauri::command]
async fn acknowledge_terminal_output(
    session_id: u64,
    terminal_id: u64,
    sequence: u64,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    state
        .registry
        .lock()
        .await
        .acknowledge(session_id, terminal_id, sequence)
}

async fn terminal_sender(
    state: &DesktopState,
    session_id: u64,
    terminal_id: u64,
) -> Result<mpsc::Sender<TerminalInput>, String> {
    state.registry.lock().await.sender(session_id, terminal_id)
}
#[tauri::command]
async fn terminal_input(
    session_id: u64,
    terminal_id: u64,
    data: Vec<u8>,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    if data.len() > TERMINAL_CHUNK {
        return Err("Terminal input chunk exceeds 64 KiB".into());
    }
    let sender = terminal_sender(&state, session_id, terminal_id).await?;
    tokio::time::timeout(OP_TIMEOUT, sender.send(TerminalInput::Data(data)))
        .await
        .map_err(error)?
        .map_err(error)
}
#[tauri::command]
async fn terminal_resize(
    session_id: u64,
    terminal_id: u64,
    cols: u32,
    rows: u32,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let sender = terminal_sender(&state, session_id, terminal_id).await?;
    tokio::time::timeout(OP_TIMEOUT, sender.send(TerminalInput::Resize(cols, rows)))
        .await
        .map_err(error)?
        .map_err(error)
}
#[tauri::command]
async fn close_terminal(
    session_id: u64,
    terminal_id: u64,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    state
        .registry
        .lock()
        .await
        .close_terminal(session_id, terminal_id);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window
                    .try_state::<DesktopState>()
                    .is_some_and(|s| s.mappings.has_running())
                {
                    use tauri::Emitter;
                    api.prevent_close();
                    let _ = window.emit("drive-mappings-close-blocked", ());
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.try_state::<DesktopState>() {
                    state.directories.close_owner(window.label());
                }
            }
        })
        .invoke_system(native_ipc::initialization_script())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(extension_frames::plugin())
        .manage(extension_frames::FrameDocuments::default())
        .setup(|app| {
            #[cfg(debug_assertions)]
            extension_probe::setup(app)?;
            #[cfg(not(debug_assertions))]
            let _ = app;
            Ok(())
        })
        .manage(DesktopState::default())
        .manage(drive_bridge_install::Reviews::default())
        .manage(adapters::AdapterJobs::default())
        .manage(adapter_diagnostics::AdapterDiagnostics::default())
        .manage(custom_services::CustomRequests::default())
        .invoke_handler(|invoke| {
            #[cfg(debug_assertions)]
            if invoke.message.command() == "review_fixture_adapter" {
                let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
                    tauri::generate_handler![adapters::review_fixture_adapter];
                return handler(invoke);
            }
            #[cfg(debug_assertions)]
            if invoke.message.command() == "live_clipboard_probe_context" {
                let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
                    tauri::generate_handler![extension_probe::live_clipboard_probe_context];
                return handler(invoke);
            }
            #[cfg(debug_assertions)]
            if invoke.message.command() == "catalog_probe_context" {
                let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
                    tauri::generate_handler![extension_probe::catalog_probe_context];
                return handler(invoke);
            }
            #[cfg(debug_assertions)]
            if invoke.message.command() == "channel_roundtrip" {
                let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool =
                    tauri::generate_handler![extension_probe::channel_roundtrip];
                return handler(invoke);
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                client_platform,
                drive_bridge_install::drive_bridge_installation,
                drive_bridge_install::review_drive_bridge,
                drive_bridge_install::cancel_drive_bridge_review,
                drive_bridge_install::install_drive_bridge,
                drive_mappings::drive_mappings,
                drive_mappings::drive_mapping_available,
                drive_mappings::attach_drive,
                drive_mappings::detach_drive,
                drive_mappings::dismiss_drive,
                drive_mappings::retry_drive_cleanup,
                drive_mappings::open_drive_location,
                repository_install::read_repository_file,
                repository_install::prepare_repository_read,
                repository_install::cancel_repository_read,
                app_network::app_network_profile,
                app_network::app_network_configure,
                app_network::app_network_forget,
                app_network::app_network_prepare,
                app_network::app_network_start,
                app_network::app_network_read,
                app_network::app_network_close,
                adapters::list_adapters,
                adapter_diagnostics::adapter_diagnostics,
                adapters::available_connections,
                workspace_profiles::list_workspace_profiles,
                workspace_profiles::save_workspace_profile,
                workspace_profiles::remove_workspace_profile,
                custom_services::list_custom_services,
                custom_services::begin_custom_call,
                custom_services::cancel_custom_call,
                custom_services::call_custom_service,
                adapters::connect_adapters,
                adapters::replace_adapter_source,
                adapters::review_adapter,
                adapters::cancel_adapter_review,
                adapters::install_adapter,
                adapters::set_adapter_enabled,
                adapters::remove_adapter,
                extension_frames::publish_app_frame,
                extension_frames::release_app_frame,
                profiles,
                read_host_settings,
                apply_host_setting,
                save_profile,
                remove_profile,
                session_alive,
                session_status,
                connect,
                begin_connect,
                cancel_connect,
                decide_host_key,
                disconnect,
                list_directory,
                file_volumes,
                set_volume_mounted,
                directories::open_directory,
                directories::read_directory,
                directories::close_directory,
                preview_file,
                read_text,
                save_text,
                create_text,
                make_directory,
                rename_entry,
                move_entry,
                remove_entry,
                transfers::choose_upload_files,
                transfers::choose_download_file,
                transfers::choose_download_files,
                transfers::copy_system_files,
                transfers::cancel_clipboard_preparation,
                transfers::cut_system_file,
                transfers::paste_system_files,
                transfers::inspect_system_files,
                transfers::paste_copied_files,
                transfers::paste_moved_files,
                transfers::cancel_system_cut,
                transfers::prepare_file_copy_selection,
                transfers::system_clipboard_sequence,
                transfers::prepare_file_copy,
                transfers::run_transfer,
                transfers::cancel_transfer,
                open_terminal,
                terminal_input,
                acknowledge_terminal_output,
                terminal_resize,
                close_terminal
            ];
            handler(invoke)
        })
        .build(tauri::generate_context!())
        .expect("Unable to start ShellCanvas")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if app.state::<DesktopState>().mappings.has_running() {
                    use tauri::Emitter;
                    api.prevent_exit();
                    let _ = app.emit("drive-mappings-close-blocked", ());
                }
            }
        });
}
