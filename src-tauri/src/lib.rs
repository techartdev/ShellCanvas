// SPDX-License-Identifier: MPL-2.0
use serde::Serialize;
use shellcanvas_core::*;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tauri::{ipc::Channel, State};
use tokio::sync::{mpsc, Mutex};
#[cfg(windows)]
mod clipboard_stream;
mod connection_attempts;
mod connection_resource;
mod host_trust;
mod profile_store;
mod session_registry;
mod terminals;
mod transfers;
#[cfg(windows)]
mod windows_clipboard;
#[cfg(windows)]
mod windows_file_input;
mod workspace_services;
use connection_resource::ConnectionResource;
use session_registry::SessionRegistry;
use workspace_services::WorkspaceServices as ActiveSession;
#[derive(Default)]
struct DesktopState {
    registry: Arc<Mutex<SessionRegistry<ActiveSession>>>,
    next_id: AtomicU64,
    attempts: Mutex<connection_attempts::ConnectionAttempts>,
    transfers: Mutex<transfers::TransferRegistry>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    id: u64,
    info: HostInfo,
    connections: Vec<ConnectionIdentity>,
    services: Vec<workspace_services::ServiceStatus>,
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
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
    let files: Option<Arc<dyn FileSystemProvider>> = match connection.sftp().await {
        Ok(sftp) => {
            info.home = tokio::time::timeout(OP_TIMEOUT, sftp.canonicalize("."))
                .await
                .ok()
                .and_then(Result::ok);
            info.capabilities.push("files.read".into());
            Some(Arc::new(SftpFileSystem(sftp)))
        }
        Err(e) => {
            info.notices.push(format!("File browsing unavailable: {e}"));
            None
        }
    };
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let mut mutations: Option<Arc<dyn FileMutationService>> = None;
    let mut moves: Option<Arc<dyn FileMoveService>> = None;
    let mut transfers: Option<Arc<dyn FileTransferService>> = None;
    let text: Option<Arc<dyn TextFileService>> = if files.is_some() {
        match connection.text_files().await {
            Ok(service) => {
                if service.can_save() {
                    info.capabilities.push("files.edit".into());
                }
                let service = Arc::new(service);
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
            Err(_) => {
                info.notices
                    .push("Text files can be previewed, but remote saving is unavailable.".into());
                None
            }
        }
    } else {
        None
    };
    let resource = ConnectionResource::new(
        ConnectionIdentity {
            instance: state.next_id.fetch_add(1, Ordering::Relaxed) + 1,
            generation: 1,
            adapter: "ssh".into(),
        },
        connection.clone(),
    );
    let mut active = ActiveSession::new(vec![resource.clone()])?;
    active.bind_terminal(&resource, connection.clone())?;
    if let Some(service) = files {
        active.bind_files(&resource, service)?;
    }
    if let Some(service) = text {
        active.bind_text(&resource, service)?;
    }
    if let Some(service) = mutations {
        active.bind_mutations(&resource, service)?;
    }
    if let Some(service) = moves {
        active.bind_moves(&resource, service)?;
    }
    if let Some(service) = transfers {
        active.bind_transfers(&resource, service)?;
    }
    if let Some(service) = settings {
        active.bind_settings(&resource, service)?;
    }
    let connections = active.identities();
    active.advertise_capabilities(&info.capabilities);
    let services = active.status().services;
    state.registry.lock().await.sessions.insert(id, active);
    Ok(SessionInfo {
        id,
        info,
        connections,
        services,
    })
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
    let removed = state.registry.lock().await.remove(session_id);
    state.transfers.lock().await.close_session(session_id);
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
) -> Result<Arc<dyn FileSystemProvider>, String> {
    let guard = state.registry.lock().await;
    let active = guard
        .sessions
        .get(&session_id)
        .ok_or("This host session is no longer connected")?;
    active
        .files
        .clone()
        .ok_or("File browsing is not available in this workspace".into())
}

async fn host_settings(
    state: &DesktopState,
    session_id: u64,
) -> Result<Arc<dyn HostSettingsService>, String> {
    state
        .registry
        .lock()
        .await
        .sessions
        .get(&session_id)
        .and_then(|session| session.settings.clone())
        .ok_or("Remote settings are unavailable for this host".into())
}
#[tauri::command]
async fn read_host_settings(
    session_id: u64,
    state: State<'_, DesktopState>,
) -> Result<Vec<HostSetting>, String> {
    host_settings(&state, session_id)
        .await?
        .read()
        .await
        .map_err(|error| format!("{error:#}"))
}
#[tauri::command]
async fn apply_host_setting(
    session_id: u64,
    id: String,
    value: String,
    revision: String,
    state: State<'_, DesktopState>,
) -> Result<HostSetting, String> {
    host_settings(&state, session_id)
        .await?
        .apply(&id, &value, &revision)
        .await
        .map_err(|error| format!("{error:#}"))
}
#[tauri::command]
async fn list_directory(
    session_id: u64,
    path: Option<String>,
    state: State<'_, DesktopState>,
) -> Result<Directory, String> {
    filesystem(&state, session_id)
        .await?
        .list(path.as_deref())
        .await
        .map_err(|e| format!("{e:#}"))
}
#[tauri::command]
async fn preview_file(
    session_id: u64,
    path: String,
    state: State<'_, DesktopState>,
) -> Result<String, String> {
    filesystem(&state, session_id)
        .await?
        .preview(&path)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn read_text(
    session_id: u64,
    path: String,
    state: State<'_, DesktopState>,
) -> Result<TextDocument, String> {
    let text = state
        .registry
        .lock()
        .await
        .sessions
        .get(&session_id)
        .and_then(|s| s.text.clone());
    if let Some(service) = text {
        return service.read_text(&path).await.map_err(|e| format!("{e:#}"));
    }
    let files = filesystem(&state, session_id).await?;
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
    path: String,
    text: String,
    revision: String,
    state: State<'_, DesktopState>,
) -> Result<TextDocument, String> {
    let service = state
        .registry
        .lock()
        .await
        .sessions
        .get(&session_id)
        .and_then(|s| s.text.clone())
        .ok_or("Text saving is unavailable for this session")?;
    service
        .save_text(&path, &text, &revision)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn create_text(
    session_id: u64,
    parent: String,
    name: String,
    text: String,
    state: State<'_, DesktopState>,
) -> Result<TextDocument, String> {
    let service = state
        .registry
        .lock()
        .await
        .sessions
        .get(&session_id)
        .and_then(|s| s.text.clone())
        .ok_or("File creation is unavailable for this session")?;
    service
        .create_text(&parent, &name, &text)
        .await
        .map_err(|e| format!("{e:#}"))
}
async fn file_mutations(
    state: &DesktopState,
    session_id: u64,
) -> Result<Arc<dyn FileMutationService>, String> {
    state
        .registry
        .lock()
        .await
        .sessions
        .get(&session_id)
        .and_then(|s| s.mutations.clone())
        .ok_or("File changes are unavailable for this session".into())
}
#[tauri::command]
async fn make_directory(
    session_id: u64,
    parent: String,
    name: String,
    state: State<'_, DesktopState>,
) -> Result<String, String> {
    file_mutations(&state, session_id)
        .await?
        .make_directory(&parent, &name)
        .await
        .map_err(|e| format!("{e:#}"))
}
#[tauri::command]
async fn rename_entry(
    session_id: u64,
    path: String,
    name: String,
    revision: String,
    tracked: Vec<String>,
    state: State<'_, DesktopState>,
) -> Result<FileRelocation, String> {
    file_mutations(&state, session_id)
        .await?
        .rename_tracked(&path, &name, &revision, &tracked)
        .await
        .map_err(|e| format!("{e:#}"))
}
#[tauri::command]
async fn move_entry(
    session_id: u64,
    path: String,
    parent: String,
    revision: String,
    tracked: Vec<String>,
    state: State<'_, DesktopState>,
) -> Result<FileRelocation, String> {
    let service = state
        .registry
        .lock()
        .await
        .sessions
        .get(&session_id)
        .and_then(|s| s.moves.clone())
        .ok_or("Moving files is unavailable for this session")?;
    service
        .move_tracked(&path, &parent, &revision, &tracked)
        .await
        .map_err(|e| format!("{e:#}"))
}
#[tauri::command]
async fn remove_entry(
    session_id: u64,
    path: String,
    revision: String,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    file_mutations(&state, session_id)
        .await?
        .remove_entry(&path, &revision)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn open_terminal(
    session_id: u64,
    cols: u32,
    rows: u32,
    on_event: Channel<TerminalEvent>,
    state: State<'_, DesktopState>,
) -> Result<u64, String> {
    let terminal = state
        .registry
        .lock()
        .await
        .sessions
        .get(&session_id)
        .and_then(|s| s.terminal.clone())
        .ok_or("Terminal service is unavailable for this host session")?;
    let stream = tokio::time::timeout(OP_TIMEOUT, terminal.open(TerminalSize::new(cols, rows)))
        .await
        .map_err(error)?
        .map_err(error)?;
    let (send, recv) = mpsc::channel(128);
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let canceled = state
        .registry
        .lock()
        .await
        .add_terminal(session_id, id, send)?;
    let registry = state.registry.clone();
    tauri::async_runtime::spawn(async move {
        terminals::run_terminal(stream, recv, canceled, |event| on_event.send(event).is_ok()).await;
        registry.lock().await.close_terminal(session_id, id);
    });
    Ok(id)
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopState::default())
        .invoke_handler(tauri::generate_handler![
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
            transfers::cut_system_file,
            transfers::paste_system_files,
            transfers::system_clipboard_sequence,
            transfers::prepare_file_copy,
            transfers::run_transfer,
            transfers::cancel_transfer,
            open_terminal,
            terminal_input,
            terminal_resize,
            close_terminal
        ])
        .run(tauri::generate_context!())
        .expect("Unable to start ShellCanvas");
}
