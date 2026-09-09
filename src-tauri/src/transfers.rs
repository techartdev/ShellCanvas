// SPDX-License-Identifier: MPL-2.0
use crate::workspace_services::ServiceRole;
use crate::{error, DesktopState};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use shellcanvas_core::{FileTransferService, TRANSFER_CHUNK};
use shellcanvas_services::ConnectionIdentity;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Instant, SystemTime},
};
use tauri::{ipc::Channel, State};
use tauri_plugin_dialog::DialogExt;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{watch, Semaphore},
};

#[path = "transfer_catalog.rs"]
pub(crate) mod catalog;
#[cfg(test)]
#[path = "transfer_folder_tests.rs"]
mod folder_tests;
#[cfg(test)]
#[path = "transfer_tests.rs"]
mod tests;
#[path = "transfer_tree.rs"]
mod tree;

#[cfg(windows)]
#[derive(Clone)]
pub(crate) enum RemoteClipboardSelection {
    Copy {
        owner: u64,
        service: Arc<dyn FileTransferService>,
        catalog: Arc<catalog::Catalog>,
    },
    Cut(Arc<crate::clipboard_move::CutSelection>),
}
#[cfg(windows)]
impl RemoteClipboardSelection {
    fn prepare(
        &self,
        owner: u64,
        service: &Arc<dyn FileTransferService>,
        parent: String,
    ) -> Result<(Job, String, u64, &'static str)> {
        let Self::Copy {
            owner: source_owner,
            service: source_service,
            catalog: source_catalog,
        } = self
        else {
            bail!("This clipboard selection was cut. Use Move Paste instead of Copy Paste.");
        };
        if *source_owner != owner || !Arc::ptr_eq(source_service, service) {
            bail!("Copied files belong to another workspace or an earlier file connection. Copy them again on this connection.");
        }
        let catalog = Arc::new(catalog::Catalog::new(false)?);
        let mut after = 0;
        while let Some(root) = source_catalog.root_after(after)? {
            after = root.id;
            catalog.add(None, vec![(root.entry, root.local)])?;
        }
        let count = catalog.len();
        if count == 0 {
            bail!("The copied selection is empty");
        }
        let name = if count == 1 {
            catalog.get(1)?.entry.name
        } else {
            format!("{count} copied items")
        };
        let size = catalog.size();
        Ok((Job::Selection { catalog, parent }, name, size, "copy"))
    }
}
#[derive(Serialize)]
pub struct ClipboardFileState {
    kind: &'static str,
    sequence: u32,
    intent: &'static str,
}
#[tauri::command]
pub async fn inspect_system_files() -> Result<ClipboardFileState, String> {
    #[cfg(windows)]
    {
        let snapshot = crate::windows_clipboard::snapshot().await?;
        let retired =
            matches!(&snapshot.remote, Some(RemoteClipboardSelection::Cut(cut)) if cut.retired());
        Ok(ClipboardFileState {
            kind: if retired {
                "empty"
            } else if snapshot.remote.is_some() {
                "remote"
            } else if snapshot.local {
                "local"
            } else {
                "empty"
            },
            sequence: snapshot.sequence,
            intent: if matches!(snapshot.remote, Some(RemoteClipboardSelection::Cut(_))) {
                "move"
            } else {
                "copy"
            },
        })
    }
    #[cfg(not(windows))]
    {
        Err("Native file clipboard integration is unavailable on this platform".into())
    }
}
#[tauri::command]
pub async fn paste_copied_files(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    parent: String,
    sequence: u32,
    state: State<'_, DesktopState>,
) -> Result<Vec<Ticket>, String> {
    #[cfg(windows)]
    {
        if parent.is_empty() {
            return Err("Choose a remote destination folder".into());
        }
        let service = provider(&state, session_id, binding.as_ref()).await?;
        let snapshot = crate::windows_clipboard::snapshot().await?;
        if snapshot.sequence != sequence {
            return Err("The clipboard changed before Paste. Try again.".into());
        }
        let selection = snapshot
            .remote
            .ok_or("The clipboard no longer contains a ShellCanvas remote selection")?;
        let target = service.clone();
        let job =
            tokio::task::spawn_blocking(move || selection.prepare(session_id, &target, parent))
                .await
                .map_err(error)?
                .map_err(error)?;
        let registry = state.registry.lock().await;
        registry
            .sessions
            .get(&session_id)
            .ok_or("Host disconnected during preparation")?
            .check_source(&ServiceRole::Files, binding.as_ref())?;
        state
            .transfers
            .lock()
            .await
            .add(session_id, service, vec![job])
    }
    #[cfg(not(windows))]
    {
        let _ = (session_id, binding, parent, sequence, state);
        Err("Native file clipboard integration is unavailable on this platform".into())
    }
}

#[tauri::command]
pub async fn paste_moved_files(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    parent: String,
    sequence: u32,
    state: State<'_, DesktopState>,
) -> Result<Vec<Ticket>, String> {
    #[cfg(windows)]
    {
        let service = crate::session_service(
            &state,
            session_id,
            binding.as_ref(),
            ServiceRole::Files,
            |s| s.moves.clone(),
        )
        .await?;
        let snapshot = crate::windows_clipboard::snapshot().await?;
        if snapshot.sequence != sequence {
            return Err("The clipboard changed before Paste. Try again.".into());
        }
        let Some(RemoteClipboardSelection::Cut(cut)) = snapshot.remote else {
            return Err("The clipboard no longer contains a cut item".into());
        };
        let claim = cut.prepare(session_id, &service, parent).map_err(error)?;
        let registry = state.registry.lock().await;
        registry
            .sessions
            .get(&session_id)
            .ok_or("Host disconnected during preparation")?
            .check_source(&ServiceRole::Files, binding.as_ref())?;
        state
            .transfers
            .lock()
            .await
            .add_move(session_id, claim, cut.name.clone())
    }
    #[cfg(not(windows))]
    {
        let _ = (session_id, binding, parent, sequence, state);
        Err("Native file clipboard integration is unavailable on this platform".into())
    }
}

#[tauri::command]
pub async fn cancel_system_cut(session_id: u64, sequence: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        let snapshot = crate::windows_clipboard::snapshot().await?;
        if snapshot.sequence == sequence {
            if let Some(RemoteClipboardSelection::Cut(cut)) = snapshot.remote {
                cut.cancel(session_id).map_err(error)?;
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (session_id, sequence);
        Ok(())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    pub id: u64,
    pub name: String,
    pub size: u64,
    pub direction: &'static str,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub bytes: u64,
    pub total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<u64>,
    pub phase: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub status: &'static str,
    pub bytes: u64,
    pub total: u64,
    pub message: Option<String>,
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relocation: Option<shellcanvas_services::FileRelocation>,
}
enum Job {
    DownloadSelection {
        catalog: Arc<catalog::Catalog>,
        folder: PathBuf,
    },
    Selection {
        catalog: Arc<catalog::Catalog>,
        parent: String,
    },
    Tree {
        tree: tree::Tree,
        target: tree::Target,
    },
    Copy {
        path: String,
        revision: String,
        parent: String,
        name: String,
    },
    Upload {
        file: std::fs::File,
        parent: String,
        name: String,
        size: u64,
        modified: Option<SystemTime>,
    },
    Download {
        destination: PathBuf,
        path: String,
        revision: String,
    },
}
enum Work {
    Transfer {
        job: Job,
        service: Arc<dyn FileTransferService>,
    },
    #[cfg(any(windows, test))]
    Move(crate::clipboard_move::MoveClaim),
}
struct Pending {
    owner: u64,
    work: Option<Work>,
    cancel: watch::Sender<bool>,
}
struct ClaimedTransfer {
    work: Work,
    cancel: watch::Receiver<bool>,
    slots: Arc<Semaphore>,
}
pub struct TransferRegistry {
    next: u64,
    jobs: HashMap<u64, Pending>,
    slots: Arc<Semaphore>,
    preparations: HashMap<String, (u64, watch::Sender<bool>)>,
}
impl Default for TransferRegistry {
    fn default() -> Self {
        Self {
            next: 0,
            jobs: HashMap::new(),
            slots: Arc::new(Semaphore::new(4)),
            preparations: HashMap::new(),
        }
    }
}
impl TransferRegistry {
    fn add(
        &mut self,
        owner: u64,
        service: Arc<dyn FileTransferService>,
        jobs: Vec<(Job, String, u64, &'static str)>,
    ) -> Result<Vec<Ticket>, String> {
        self.add_work(
            owner,
            jobs.into_iter()
                .map(|(job, name, size, direction)| {
                    (
                        Work::Transfer {
                            job,
                            service: service.clone(),
                        },
                        name,
                        size,
                        direction,
                    )
                })
                .collect(),
        )
    }
    #[cfg(any(windows, test))]
    fn add_move(
        &mut self,
        owner: u64,
        claim: crate::clipboard_move::MoveClaim,
        name: String,
    ) -> Result<Vec<Ticket>, String> {
        self.add_work(owner, vec![(Work::Move(claim), name, 0, "move")])
    }
    fn add_work(
        &mut self,
        owner: u64,
        jobs: Vec<(Work, String, u64, &'static str)>,
    ) -> Result<Vec<Ticket>, String> {
        if self.jobs.len() + jobs.len() > 32 {
            return Err("The transfer queue is full. Finish or cancel some files first.".into());
        }
        Ok(jobs
            .into_iter()
            .map(|(work, name, size, direction)| {
                self.next += 1;
                let id = self.next;
                self.jobs.insert(
                    id,
                    Pending {
                        owner,
                        work: Some(work),
                        cancel: watch::channel(false).0,
                    },
                );
                Ticket {
                    id,
                    name,
                    size,
                    direction,
                }
            })
            .collect())
    }
    fn claim(&mut self, owner: u64, id: u64) -> Result<ClaimedTransfer, String> {
        let pending = self
            .jobs
            .get_mut(&id)
            .filter(|p| p.owner == owner)
            .ok_or("Transfer is closed or belongs to another host")?;
        let work = pending.work.take().ok_or("Transfer already started")?;
        Ok(ClaimedTransfer {
            work,
            cancel: pending.cancel.subscribe(),
            slots: self.slots.clone(),
        })
    }
    fn cancel(&mut self, owner: u64, id: u64) -> Result<(), String> {
        if let Some(pending) = self.jobs.get(&id) {
            if pending.owner != owner {
                return Err("Transfer belongs to another host".into());
            }
            if pending.work.is_some() {
                self.jobs.remove(&id);
            } else {
                pending.cancel.send_replace(true);
            }
        }
        Ok(())
    }
    pub fn close_session(&mut self, owner: u64) {
        self.preparations.retain(|_, (session, cancel)| {
            if *session == owner {
                cancel.send_replace(true);
                false
            } else {
                true
            }
        });
        self.jobs.retain(|_, p| {
            if p.owner != owner {
                return true;
            }
            p.cancel.send_replace(true);
            p.work.is_none()
        });
    }
}
async fn provider(
    state: &DesktopState,
    session: u64,
    binding: Option<&ConnectionIdentity>,
) -> Result<Arc<dyn FileTransferService>, String> {
    crate::session_service(state, session, binding, ServiceRole::Files, |s| {
        s.transfers.clone()
    })
    .await
}
#[tauri::command]
pub async fn choose_upload_files(
    app: tauri::AppHandle,
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    parent: String,
    folder: Option<bool>,
    state: State<'_, DesktopState>,
) -> Result<Vec<Ticket>, String> {
    let service = provider(&state, session_id, binding.as_ref()).await?;
    let jobs = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<_>, String> {
        if folder.unwrap_or(false) {
            let Some(selected) = app
                .dialog()
                .file()
                .set_title("Upload folder")
                .blocking_pick_folder()
            else {
                return Ok(Vec::new());
            };
            return selected_uploads(vec![selected.into_path().map_err(error)?], parent);
        }
        let paths = app
            .dialog()
            .file()
            .set_title("Upload files to this folder")
            .blocking_pick_files()
            .unwrap_or_default();
        let paths = paths
            .into_iter()
            .map(|selected| selected.into_path().map_err(error))
            .collect::<Result<Vec<_>, _>>()?;
        selected_uploads(paths, parent)
    })
    .await
    .map_err(error)??;
    let registry = state.registry.lock().await;
    registry
        .sessions
        .get(&session_id)
        .ok_or("The host disconnected during preparation")?
        .check_source(&ServiceRole::Files, binding.as_ref())?;
    state.transfers.lock().await.add(session_id, service, jobs)
}
#[tauri::command]
pub async fn choose_download_file(
    app: tauri::AppHandle,
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    path: String,
    revision: String,
    state: State<'_, DesktopState>,
) -> Result<Option<Ticket>, String> {
    let service = provider(&state, session_id, binding.as_ref()).await?;
    let location = crate::filesystem(&state, session_id, binding.as_ref())
        .await?
        .locate(&path)
        .await
        .map_err(error)?;
    let name: String = location
        .name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let suggestion = name.trim_end_matches(['.', ' ']).to_owned();
    let destination = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Download file — choose a new name")
            .set_file_name(if suggestion.is_empty() {
                "download.bin"
            } else {
                &suggestion
            })
            .blocking_save_file()
    })
    .await
    .map_err(error)?;
    let Some(destination) = destination else {
        return Ok(None);
    };
    let destination = destination.into_path().map_err(error)?;
    if destination.try_exists().map_err(error)? {
        return Err(
            "That local file already exists. Download again with a new name; nothing was replaced."
                .into(),
        );
    }
    let registry = state.registry.lock().await;
    registry
        .sessions
        .get(&session_id)
        .ok_or("The host disconnected during preparation")?
        .check_source(&ServiceRole::Files, binding.as_ref())?;
    let mut tickets = state.transfers.lock().await.add(
        session_id,
        service,
        vec![(
            Job::Download {
                destination,
                path,
                revision,
            },
            location.name,
            0,
            "download",
        )],
    )?;
    Ok(tickets.pop())
}

#[derive(Deserialize)]
pub struct DownloadSource {
    path: String,
    revision: String,
}
fn download_name(name: &str) -> Result<(), String> {
    let stem = name.split('.').next().unwrap_or("").to_uppercase();
    if name.is_empty()
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|n| {
                matches!(
                    n,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
    {
        return Err(format!("{name:?} is not a portable local filename. Download it individually and choose a new name."));
    }
    Ok(())
}
#[tauri::command]
pub async fn choose_download_files(
    app: tauri::AppHandle,
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    files: Vec<DownloadSource>,
    state: State<'_, DesktopState>,
) -> Result<Vec<Ticket>, String> {
    if files.is_empty()
        || files
            .iter()
            .any(|file| file.path.is_empty() || file.revision.is_empty())
    {
        return Err("Choose versioned files or folders to download.".into());
    }
    let service = provider(&state, session_id, binding.as_ref()).await?;
    let catalog = Arc::new(catalog::Catalog::new(true).map_err(error)?);
    for file in &files {
        let tree = remote_tree(&service, file).await?;
        catalog
            .add(None, vec![(tree.root.entry, tree.root.local)])
            .map_err(error)?;
        tokio::task::yield_now().await;
    }
    let destination = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("Download files — choose a destination folder")
            .blocking_pick_folder()
    })
    .await
    .map_err(error)?;
    let Some(destination) = destination else {
        return Ok(Vec::new());
    };
    let folder = destination
        .into_path()
        .map_err(error)?
        .canonicalize()
        .map_err(error)?;
    let job = tauri::async_runtime::spawn_blocking(move || selected_downloads(catalog, folder))
        .await
        .map_err(error)??;
    let registry = state.registry.lock().await;
    registry
        .sessions
        .get(&session_id)
        .ok_or("The host disconnected during preparation")?
        .check_source(&ServiceRole::Files, binding.as_ref())?;
    state
        .transfers
        .lock()
        .await
        .add(session_id, service, vec![job])
}

fn selected_downloads(
    catalog: Arc<catalog::Catalog>,
    folder: PathBuf,
) -> Result<(Job, String, u64, &'static str), String> {
    tree::check_download_selection(&catalog, &folder).map_err(error)?;
    let count = catalog.len();
    let name = if count == 1 {
        catalog.get(1).map_err(error)?.entry.name
    } else {
        format!("{count} selected items")
    };
    let size = catalog.size();
    Ok((
        Job::DownloadSelection { catalog, folder },
        name,
        size,
        "download",
    ))
}

async fn remote_tree(
    service: &Arc<dyn FileTransferService>,
    file: &DownloadSource,
) -> Result<tree::Tree, String> {
    let entry = service
        .clone()
        .transfer_entry(&file.path, &file.revision)
        .await
        .map_err(error)?;
    tree::remote(service, entry).await.map_err(error)
}
#[tauri::command]
pub async fn prepare_file_copy_selection(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    files: Vec<DownloadSource>,
    parent: String,
    state: State<'_, DesktopState>,
) -> Result<Ticket, String> {
    if files.is_empty() || parent.is_empty() {
        return Err("Select files and a destination folder.".into());
    }
    let service = provider(&state, session_id, binding.as_ref()).await?;
    let catalog = Arc::new(catalog::Catalog::new(false).map_err(error)?);
    for file in files {
        let tree = remote_tree(&service, &file).await?;
        catalog
            .add(None, vec![(tree.root.entry, tree.root.local)])
            .map_err(error)?;
        tokio::task::yield_now().await;
    }
    let size = catalog.size();
    let name = if catalog.len() == 1 {
        catalog.get(1).map_err(error)?.entry.name
    } else {
        format!("{} copied items", catalog.len())
    };
    let registry = state.registry.lock().await;
    registry
        .sessions
        .get(&session_id)
        .ok_or("Host disconnected during preparation")?
        .check_source(&ServiceRole::Files, binding.as_ref())?;
    let mut tickets = state.transfers.lock().await.add(
        session_id,
        service,
        vec![(Job::Selection { catalog, parent }, name, size, "copy")],
    )?;
    Ok(tickets.remove(0))
}
#[tauri::command]
pub async fn cancel_clipboard_preparation(
    session_id: u64,
    operation: String,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let registry = state.transfers.lock().await;
    let (owner, cancel) = registry
        .preparations
        .get(&operation)
        .ok_or("Clipboard preparation is no longer active")?;
    if *owner != session_id {
        return Err("Clipboard preparation belongs to another host".into());
    }
    cancel.send_replace(true);
    Ok(())
}
#[cfg(windows)]
async fn prepare_clipboard(
    state: &DesktopState,
    session: u64,
    binding: Option<ConnectionIdentity>,
    files: Vec<DownloadSource>,
    operation: String,
    on_event: Channel<Progress>,
    cut: Option<Arc<crate::clipboard_move::CutSelection>>,
) -> Result<u32, String> {
    let sequence = crate::windows_file_input::sequence();
    let (stop, cancel) = watch::channel(false);
    let slots = {
        let mut registry = state.transfers.lock().await;
        if operation.is_empty()
            || operation.len() > 128
            || registry.preparations.contains_key(&operation)
        {
            return Err("Invalid clipboard preparation identity".into());
        }
        if registry.preparations.len() >= 4 {
            return Err(
                "Clipboard preparation is busy. Finish or cancel another preparation.".into(),
            );
        }
        registry
            .preparations
            .insert(operation.clone(), (session, stop));
        registry.slots.clone()
    };
    let work: Result<u32> = async {
        // Acknowledge registration before waiting for workers or provider I/O.
        // Owners canceled during dispatch can now cancel the registered request.
        let _ = on_event.send(Progress { items: Some(0), bytes: 0, total: 0, phase: "preparing" });
        checkpoint(&cancel)?;
        let _permit = tokio::select! { permit = slots.acquire() => permit?, _ = wait_for_cancel(cancel.clone()) => bail!("Transfer canceled") };
        let service = provider(state, session, binding.as_ref()).await.map_err(anyhow::Error::msg)?;
        let roots = Arc::new(catalog::Catalog::new(true)?);
        let mut last = Instant::now();
        for file in files {
            checkpoint(&cancel)?;
            let tree = remote_tree(&service, &file).await.map_err(anyhow::Error::msg)?;
            roots.add(None, vec![(tree.root.entry, tree.root.local)])?;
            tokio::task::yield_now().await;
        }
        let catalog = tree::scan_catalog(roots, service.clone(), &cancel, &mut |event| {
                if last.elapsed().as_millis() >= 100 { let _ = on_event.send(event); last = Instant::now(); }
            }).await?;
            // The descriptor format itself has a fixed-size path field.
            for id in 1..=catalog.len() {
                checkpoint(&cancel)?;
                if catalog.get(id)?.display.encode_utf16().count() >= 260 { bail!("A folder path is too long for Explorer's clipboard (259 characters). Use Download instead."); }
                if id % shellcanvas_core::TRANSFER_DIRECTORY_PAGE as u64 == 0 { tokio::task::yield_now().await; }
            }
        checkpoint(&cancel)?;
        state.registry.lock().await.sessions.get(&session).ok_or_else(|| anyhow::anyhow!("Host disconnected while preparing clipboard"))?
            .check_source(&ServiceRole::Files, binding.as_ref()).map_err(anyhow::Error::msg)?;
        let remote = match cut {
            Some(cut) => RemoteClipboardSelection::Cut(cut),
            None => RemoteClipboardSelection::Copy { owner: session, service: service.clone(), catalog: catalog.clone() },
        };
        let sources = crate::clipboard_stream::Sources::catalogs(vec![catalog], service, tokio::runtime::Handle::current());
        crate::windows_clipboard::publish_selection(sources, sequence, Some(remote)).await.map_err(anyhow::Error::msg)
    }.await;
    state.transfers.lock().await.preparations.remove(&operation);
    work.map_err(error)
}
#[tauri::command]
pub async fn copy_system_files(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    files: Vec<DownloadSource>,
    operation: Option<String>,
    on_event: Channel<Progress>,
    state: State<'_, DesktopState>,
) -> Result<u32, String> {
    if files.is_empty() {
        return Err("Select files or folders to copy.".into());
    }
    #[cfg(not(windows))]
    {
        let _ = (session_id, binding, files, operation, on_event, state);
        Err("File clipboard integration is currently available on Windows.".into())
    }
    #[cfg(windows)]
    prepare_clipboard(
        &state,
        session_id,
        binding,
        files,
        operation.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        on_event,
        None,
    )
    .await
}
#[tauri::command]
pub async fn system_clipboard_sequence() -> Result<u32, String> {
    #[cfg(windows)]
    {
        crate::windows_clipboard::current_sequence().await
    }
    #[cfg(not(windows))]
    {
        Ok(0)
    }
}

// Capture root metadata in one disk catalog. Contents open only when their turn runs.
// No local path is supplied by JS or exposed in the returned ticket.
#[cfg(any(windows, test))]
fn clipboard_uploads(
    paths: Vec<PathBuf>,
    parent: String,
) -> Result<Vec<(Job, String, u64, &'static str)>, String> {
    if paths.is_empty() {
        return Err("Copy files or folders first.".into());
    }
    local_uploads(paths, parent, "clipboard")
}

fn selected_uploads(
    paths: Vec<PathBuf>,
    parent: String,
) -> Result<Vec<(Job, String, u64, &'static str)>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    local_uploads(paths, parent, "selected")
}

fn local_uploads(
    paths: Vec<PathBuf>,
    parent: String,
    label: &str,
) -> Result<Vec<(Job, String, u64, &'static str)>, String> {
    let roots = Arc::new(catalog::Catalog::new(false).map_err(error)?);
    let count = paths.len();
    for path in paths {
        if !path.is_absolute() {
            return Err("Selected local paths must be absolute".into());
        }
        let tree = tree::local(path).map_err(error)?;
        roots
            .add(None, vec![(tree.root.entry, tree.root.local)])
            .map_err(error)?;
    }
    let size = roots.size();
    let name = if count == 1 {
        roots.get(1).map_err(error)?.entry.name
    } else {
        format!("{count} {label} items")
    };
    Ok(vec![(
        Job::Selection {
            catalog: roots,
            parent,
        },
        name,
        size,
        "upload",
    )])
}

#[tauri::command]
pub async fn paste_system_files(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    parent: String,
    sequence: Option<u32>,
    state: State<'_, DesktopState>,
) -> Result<Option<Vec<Ticket>>, String> {
    #[cfg(not(windows))]
    {
        let _ = (session_id, binding, parent, sequence, state);
        Err("File clipboard integration is currently available on Windows.".into())
    }
    #[cfg(windows)]
    {
        if parent.is_empty() {
            return Err("Choose a remote destination folder.".into());
        }
        let service = provider(&state, session_id, binding.as_ref()).await?;
        let jobs = tauri::async_runtime::spawn_blocking(move || {
            (match sequence {
                Some(sequence) => crate::windows_file_input::files_at(Some(sequence)),
                None => crate::windows_file_input::files(),
            })?
            .map(|paths| clipboard_uploads(paths, parent))
            .transpose()
        })
        .await
        .map_err(error)??;
        let Some(jobs) = jobs else {
            return Ok(None);
        };
        for (job, _, _, _) in &jobs {
            if let Job::Selection { catalog, .. } = job {
                if catalog.has_directories().map_err(error)? && !service.supports_folders() {
                    return Err("Folder transfers are unavailable on this device".into());
                }
            }
        }
        let registry = state.registry.lock().await;
        registry
            .sessions
            .get(&session_id)
            .ok_or("The host disconnected during preparation")?
            .check_source(&ServiceRole::Files, binding.as_ref())?;
        state
            .transfers
            .lock()
            .await
            .add(session_id, service, jobs)
            .map(Some)
    }
}

#[tauri::command]
pub async fn cut_system_file(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    path: String,
    revision: String,
    operation: Option<String>,
    export_contents: Option<bool>,
    on_event: Channel<Progress>,
    state: State<'_, DesktopState>,
) -> Result<u32, String> {
    #[cfg(not(windows))]
    {
        let _ = (
            session_id,
            binding,
            path,
            revision,
            operation,
            export_contents,
            on_event,
            state,
        );
        Err("File clipboard integration is currently available on Windows".into())
    }
    #[cfg(windows)]
    {
        let moves = crate::session_service(
            &state,
            session_id,
            binding.as_ref(),
            ServiceRole::Files,
            |s| s.moves.clone(),
        )
        .await?;
        let fs = crate::filesystem(&state, session_id, binding.as_ref()).await?;
        let location = fs.locate(&path).await.map_err(error)?;
        let parent = location.parent.ok_or("Cannot cut a filesystem root")?;
        let cut = crate::clipboard_move::CutSelection::new(
            session_id,
            moves,
            path.clone(),
            revision.clone(),
            location.name,
        )
        .map_err(error)?;
        if export_contents.unwrap_or(false) {
            if let Ok(service) = provider(&state, session_id, binding.as_ref()).await {
                let entry = service
                    .transfer_entry(&path, &revision)
                    .await
                    .map_err(error)?;
                if matches!(entry.kind.as_str(), "file" | "directory") {
                    return prepare_clipboard(
                        &state,
                        session_id,
                        binding,
                        vec![DownloadSource { path, revision }],
                        operation.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                        on_event,
                        Some(cut),
                    )
                    .await;
                }
            }
        }
        let sequence = crate::windows_file_input::sequence();
        if !fs
            .list(Some(&parent))
            .await
            .map_err(error)?
            .entries
            .iter()
            .any(|entry| entry.path == path && !revision.is_empty() && entry.revision == revision)
        {
            return Err("Selected item changed. Refresh and cut again".into());
        }
        state
            .registry
            .lock()
            .await
            .sessions
            .get(&session_id)
            .ok_or("Host disconnected while preparing clipboard")?
            .check_source(&ServiceRole::Files, binding.as_ref())?;
        crate::windows_clipboard::publish_selection(
            Vec::new().into(),
            sequence,
            Some(RemoteClipboardSelection::Cut(cut)),
        )
        .await
    }
}
#[tauri::command]
pub async fn cancel_transfer(
    session_id: u64,
    transfer_id: u64,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    state.transfers.lock().await.cancel(session_id, transfer_id)
}

#[tauri::command]
pub async fn prepare_file_copy(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    path: String,
    revision: String,
    parent: String,
    state: State<'_, DesktopState>,
) -> Result<Ticket, String> {
    if revision.is_empty() || parent.is_empty() {
        return Err("Refresh the file and choose a destination folder".into());
    }
    let service = provider(&state, session_id, binding.as_ref()).await?;
    let location = crate::filesystem(&state, session_id, binding.as_ref())
        .await?
        .locate(&path)
        .await
        .map_err(error)?;
    if location.parent.as_deref() == Some(parent.as_str()) {
        return Err("Choose a different destination folder".into());
    }
    let tree = remote_tree(
        &service,
        &DownloadSource {
            path: path.clone(),
            revision: revision.clone(),
        },
    )
    .await?;
    let destination = crate::filesystem(&state, session_id, binding.as_ref())
        .await?
        .locate(&parent)
        .await
        .map_err(error)?
        .path;
    let size = tree.root.entry.size;
    let job = if tree.root.entry.kind == "directory" {
        Job::Tree {
            tree,
            target: tree::Target::Remote(destination),
        }
    } else {
        Job::Copy {
            path: location.path,
            revision,
            parent: destination,
            name: location.name.clone(),
        }
    };
    let registry = state.registry.lock().await;
    registry
        .sessions
        .get(&session_id)
        .ok_or("The host disconnected during preparation")?
        .check_source(&ServiceRole::Files, binding.as_ref())?;
    let name = location.name;
    let mut tickets =
        state
            .transfers
            .lock()
            .await
            .add(session_id, service, vec![(job, name, size, "copy")])?;
    tickets.pop().ok_or("Copy preparation failed".into())
}
async fn wait_for_cancel(mut cancel: watch::Receiver<bool>) {
    if cancel.wait_for(|value| *value).await.is_err() {
        std::future::pending::<()>().await;
    }
}
fn checkpoint(cancel: &watch::Receiver<bool>) -> Result<()> {
    if *cancel.borrow() {
        bail!("Transfer canceled");
    }
    Ok(())
}
fn cleanup_error(original: anyhow::Error, cleanup: Result<()>) -> anyhow::Error {
    match cleanup {
        Ok(()) => original,
        Err(error) => anyhow::anyhow!("{original:#}; cleanup failed: {error:#}"),
    }
}
async fn execute(
    job: Job,
    service: Arc<dyn FileTransferService>,
    cancel: &watch::Receiver<bool>,
    progress: &mut (dyn FnMut(Progress) + Send),
) -> Result<String> {
    checkpoint(cancel)?;
    match job {
        Job::DownloadSelection { catalog, folder } => {
            tree::execute_download_selection(catalog, folder, service, cancel, progress).await
        }
        Job::Selection { catalog, parent } => {
            tree::execute_selection(catalog, parent, service, cancel, progress).await
        }
        Job::Tree { tree, target } => {
            tree::execute_tree(tree, target, service, cancel, progress).await
        }
        Job::Copy {
            path,
            revision,
            parent,
            name,
        } => shellcanvas_services::copy_regular_file(
            service,
            &path,
            &revision,
            &parent,
            &name,
            || *cancel.borrow(),
            &mut |event| {
                progress(Progress {
                    items: None,
                    bytes: event.bytes,
                    total: event.total,
                    phase: if event.finishing {
                        "finishing"
                    } else {
                        "running"
                    },
                });
            },
        )
        .await
        .map(|location| location.path),
        Job::Upload {
            file,
            parent,
            name,
            size,
            modified,
        } => {
            let mut file = tokio::fs::File::from_std(file);
            let current = file.metadata().await?;
            if current.len() != size || current.modified().ok() != modified {
                bail!("The local file changed after selection. Choose it again.");
            }
            let mut remote = service.upload(&parent, &name, size).await?;
            let work = async {
                let mut bytes = vec![0; TRANSFER_CHUNK];
                let mut offset = 0;
                loop {
                    checkpoint(cancel)?;
                    let count = file.read(&mut bytes).await?;
                    if count == 0 { break; }
                    remote.write(&bytes[..count]).await?;
                    offset += count as u64;
                    progress(Progress { items: None, bytes: offset, total: size, phase: "running" });
                }
                let after = file.metadata().await?;
                if offset != size || after.len() != size || after.modified().ok() != modified { bail!("The local file changed during upload. The remote destination was not published."); }
                checkpoint(cancel)?;
                progress(Progress { items: None, bytes: offset,total: size,phase: "finishing" });
                // Publication is not interrupted: a late cancellation cannot turn a confirmed commit into "canceled".
                Ok(remote.finish().await?.path)
            }.await;
            match work {
                Ok(path) => Ok(path),
                Err(error) => Err(cleanup_error(error, remote.abort().await)),
            }
        }
        Job::Download {
            destination,
            path,
            revision,
        } => {
            if destination.try_exists()? {
                bail!("The local destination already exists. Choose a new name.");
            }
            let parent = destination
                .parent()
                .context("Choose a local destination folder")?;
            let temporary = tempfile::NamedTempFile::new_in(parent)?;
            let output = match temporary.reopen() {
                Ok(output) => output,
                Err(error) => {
                    return Err(cleanup_error(
                        error.into(),
                        temporary.close().map_err(Into::into),
                    ))
                }
            };
            let mut output = tokio::fs::File::from_std(output);
            let mut remote = match service.download(&path, &revision).await {
                Ok(remote) => remote,
                Err(error) => {
                    drop(output);
                    return Err(cleanup_error(error, temporary.close().map_err(Into::into)));
                }
            };
            let size = remote.file().size;
            let work: Result<()> = async {
                let mut offset = 0;
                progress(Progress {
                    items: None,
                    bytes: 0,
                    total: size,
                    phase: "running",
                });
                loop {
                    checkpoint(cancel)?;
                    let bytes = remote.read().await?;
                    if bytes.is_empty() {
                        break;
                    }
                    if bytes.len() > TRANSFER_CHUNK || offset + bytes.len() as u64 > size {
                        bail!("Invalid download size from file provider");
                    }
                    output.write_all(&bytes).await?;
                    offset += bytes.len() as u64;
                    progress(Progress {
                        items: None,
                        bytes: offset,
                        total: size,
                        phase: "running",
                    });
                }
                if offset != size {
                    bail!("The remote file ended before its expected size.");
                }
                remote.finish().await?;
                output.flush().await?;
                output.sync_all().await?;
                checkpoint(cancel)?;
                progress(Progress {
                    items: None,
                    bytes: offset,
                    total: size,
                    phase: "finishing",
                });
                Ok(())
            }
            .await;
            drop(output);
            if let Err(error) = work {
                let error = cleanup_error(error, remote.abort().await);
                return Err(cleanup_error(error, temporary.close().map_err(Into::into)));
            }
            match temporary.persist_noclobber(&destination) {
                Ok(_) => Ok(destination.to_string_lossy().into_owned()),
                Err(error) => {
                    let original =
                        anyhow::anyhow!("Local destination was not published: {}", error.error);
                    Err(cleanup_error(
                        original,
                        error.file.close().map_err(Into::into),
                    ))
                }
            }
        }
    }
}
#[tauri::command]
pub async fn run_transfer(
    session_id: u64,
    transfer_id: u64,
    on_event: Channel<Progress>,
    tracked: Option<Vec<String>>,
    state: State<'_, DesktopState>,
) -> Result<Outcome, String> {
    #[cfg(not(any(windows, test)))]
    let _ = tracked;
    let ClaimedTransfer {
        work,
        mut cancel,
        slots,
    } = state
        .transfers
        .lock()
        .await
        .claim(session_id, transfer_id)?;
    let mut last = Progress {
        items: None,
        bytes: 0,
        total: 0,
        phase: "preparing",
    };
    let mut sent = Instant::now();
    let result = async {
        checkpoint(&cancel)?;
        let _permit = tokio::select! {
            permit = slots.acquire() => permit.context("Transfer scheduler closed")?,
            _ = cancel.changed() => bail!("Transfer canceled"),
        };
        match work {
            #[cfg(any(windows, test))]
            Work::Move(claim) => {
                let relocation = claim.run(&cancel, &tracked.unwrap_or_default()).await?;
                Ok((relocation.path.clone(), Some(relocation)))
            }
            Work::Transfer { job, service } => execute(job, service, &cancel, &mut |event| {
                if event.phase != last.phase
                    || sent.elapsed().as_millis() >= 100
                    || event.bytes == event.total
                {
                    let _ = on_event.send(event.clone());
                    sent = Instant::now();
                }
                last = event;
            })
            .await
            .map(|path| (path, None)),
        }
    }
    .await;
    state.transfers.lock().await.jobs.remove(&transfer_id);
    Ok(match result {
        Ok((path, relocation)) => Outcome {
            status: "completed",
            bytes: last.bytes,
            total: last.total,
            message: None,
            path: Some(path),
            relocation,
        },
        Err(error) => {
            let message = format!("{error:#}");
            Outcome {
                status: if message.starts_with("Transfer canceled") {
                    "canceled"
                } else {
                    "failed"
                },
                bytes: last.bytes,
                total: last.total,
                message: Some(message),
                path: None,
                relocation: None,
            }
        }
    })
}
