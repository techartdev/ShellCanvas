// SPDX-License-Identifier: MPL-2.0
use serde::Serialize;
use shellcanvas_core::*;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tauri::{ipc::Channel, State};
use tokio::sync::{mpsc, Mutex, RwLock};

struct ActiveSession {
    id: u64,
    connection: Arc<Connection>,
    files: Option<Arc<dyn FileSystemProvider>>,
}
type TerminalRegistry = HashMap<u64, mpsc::Sender<TerminalInput>>;
#[derive(Default)]
struct DesktopState {
    active: RwLock<Option<ActiveSession>>,
    transition: Mutex<()>,
    next_id: AtomicU64,
    terminals: Arc<Mutex<TerminalRegistry>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    id: u64,
    info: HostInfo,
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
fn profiles() -> Vec<HostProfile> {
    local_profiles()
}

#[tauri::command]
async fn connect(
    options: ConnectOptions,
    state: State<'_, DesktopState>,
) -> Result<SessionInfo, String> {
    let _transition = state.transition.lock().await;
    state.terminals.lock().await.clear();
    if let Some(old) = state.active.write().await.take() {
        let _ = old.connection.disconnect().await;
    }
    let connection = Arc::new(
        Connection::connect(options)
            .await
            .map_err(|e| format!("{e:#}"))?,
    );
    let mut info = inspect_host(&connection).await;
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
    *state.active.write().await = Some(ActiveSession {
        id,
        connection,
        files,
    });
    Ok(SessionInfo { id, info })
}

#[tauri::command]
async fn disconnect(state: State<'_, DesktopState>) -> Result<(), String> {
    let _transition = state.transition.lock().await;
    state.terminals.lock().await.clear();
    if let Some(old) = state.active.write().await.take() {
        old.connection.disconnect().await.map_err(error)?;
    }
    Ok(())
}

#[tauri::command]
async fn session_alive(session_id: u64, state: State<'_, DesktopState>) -> Result<bool, String> {
    Ok(state
        .active
        .read()
        .await
        .as_ref()
        .is_some_and(|s| s.id == session_id && !s.connection.handle.is_closed()))
}

async fn filesystem(
    state: &DesktopState,
    session_id: u64,
) -> Result<Arc<dyn FileSystemProvider>, String> {
    let guard = state.active.read().await;
    let active = guard
        .as_ref()
        .filter(|s| s.id == session_id)
        .ok_or("This host session is no longer connected")?;
    active
        .files
        .clone()
        .ok_or("SFTP is not available on this host".into())
}

#[tauri::command]
async fn list_directory(
    session_id: u64,
    path: String,
    state: State<'_, DesktopState>,
) -> Result<Directory, String> {
    filesystem(&state, session_id)
        .await?
        .list(&path)
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
async fn open_terminal(
    session_id: u64,
    cols: u32,
    rows: u32,
    on_event: Channel<TerminalEvent>,
    state: State<'_, DesktopState>,
) -> Result<u64, String> {
    let _transition = state.transition.lock().await;
    let connection = state
        .active
        .read()
        .await
        .as_ref()
        .filter(|s| s.id == session_id)
        .map(|s| s.connection.clone())
        .ok_or("This host session is no longer connected")?;
    let channel = connection.terminal(cols, rows).await.map_err(error)?;
    let (send, recv) = mpsc::channel(128);
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    state.terminals.lock().await.insert(id, send);
    let terminals = state.terminals.clone();
    tauri::async_runtime::spawn(async move {
        run_terminal(channel, recv, |event| on_event.send(event).is_ok()).await;
        terminals.lock().await.remove(&id);
    });
    Ok(id)
}

async fn terminal_sender(
    state: &DesktopState,
    terminal_id: u64,
) -> Result<mpsc::Sender<TerminalInput>, String> {
    state
        .terminals
        .lock()
        .await
        .get(&terminal_id)
        .cloned()
        .ok_or("Terminal is closed".into())
}
#[tauri::command]
async fn terminal_input(
    terminal_id: u64,
    data: Vec<u8>,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    if data.len() > 65536 {
        return Err("Terminal input chunk exceeds 64 KiB".into());
    }
    let sender = terminal_sender(&state, terminal_id).await?;
    tokio::time::timeout(OP_TIMEOUT, sender.send(TerminalInput::Data(data)))
        .await
        .map_err(error)?
        .map_err(error)
}
#[tauri::command]
async fn terminal_resize(
    terminal_id: u64,
    cols: u32,
    rows: u32,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let sender = terminal_sender(&state, terminal_id).await?;
    tokio::time::timeout(OP_TIMEOUT, sender.send(TerminalInput::Resize(cols, rows)))
        .await
        .map_err(error)?
        .map_err(error)
}
#[tauri::command]
async fn close_terminal(terminal_id: u64, state: State<'_, DesktopState>) -> Result<(), String> {
    state.terminals.lock().await.remove(&terminal_id);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DesktopState::default())
        .invoke_handler(tauri::generate_handler![
            profiles,
            session_alive,
            connect,
            disconnect,
            list_directory,
            preview_file,
            open_terminal,
            terminal_input,
            terminal_resize,
            close_terminal
        ])
        .run(tauri::generate_context!())
        .expect("Unable to start ShellCanvas");
}
