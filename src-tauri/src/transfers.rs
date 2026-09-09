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
pub(crate) struct RemoteClipboardSelection {
    owner: u64,
    service: Arc<dyn FileTransferService>,
    catalog: Arc<catalog::Catalog>,
}
#[cfg(windows)]
impl RemoteClipboardSelection {
    fn prepare(
        &self,
        owner: u64,
        service: &Arc<dyn FileTransferService>,
        parent: String,
    ) -> Result<(Job, String, u64, &'static str)> {
        if self.owner != owner || !Arc::ptr_eq(&self.service, service) {
            bail!("Copied files belong to another workspace or an earlier file connection. Copy them again on this connection.");
        }
        let catalog = Arc::new(catalog::Catalog::new(false)?);
        let mut after = 0;
        while let Some(root) = self.catalog.root_after(after)? {
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
}
#[tauri::command]
pub async fn inspect_system_files() -> Result<ClipboardFileState, String> {
    #[cfg(windows)]
    {
        let snapshot = crate::windows_clipboard::snapshot().await?;
        Ok(ClipboardFileState {
            kind: if snapshot.remote.is_some() {
                "remote"
            } else if snapshot.local {
                "local"
            } else {
                "empty"
            },
            sequence: snapshot.sequence,
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
}
enum Job {
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
struct Pending {
    owner: u64,
    service: Arc<dyn FileTransferService>,
    job: Option<Job>,
    cancel: watch::Sender<bool>,
}
struct ClaimedTransfer {
    job: Job,
    service: Arc<dyn FileTransferService>,
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
        if self.jobs.len() + jobs.len() > 32 {
            return Err("The transfer queue is full. Finish or cancel some files first.".into());
        }
        Ok(jobs
            .into_iter()
            .map(|(job, name, size, direction)| {
                self.next += 1;
                let id = self.next;
                self.jobs.insert(
                    id,
                    Pending {
                        owner,
                        service: service.clone(),
                        job: Some(job),
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
        let job = pending.job.take().ok_or("Transfer already started")?;
        Ok(ClaimedTransfer {
            job,
            service: pending.service.clone(),
            cancel: pending.cancel.subscribe(),
            slots: self.slots.clone(),
        })
    }
    fn cancel(&mut self, owner: u64, id: u64) -> Result<(), String> {
        if let Some(pending) = self.jobs.get(&id) {
            if pending.owner != owner {
                return Err("Transfer belongs to another host".into());
            }
            if pending.job.is_some() {
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
            p.job.is_none()
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
fn source(path: &Path) -> Result<(std::fs::File, u64, Option<SystemTime>)> {
    if !std::fs::metadata(path)?.is_file() {
        bail!("Select a regular local file.");
    }
    let file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        bail!("Select a regular local file.");
    }
    Ok((file, metadata.len(), metadata.modified().ok()))
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
            return clipboard_uploads(vec![selected.into_path().map_err(error)?], parent);
        }
        let paths = app
            .dialog()
            .file()
            .set_title("Upload files to this folder")
            .blocking_pick_files()
            .unwrap_or_default();
        if paths.len() > 16 {
            return Err("Choose up to 16 files at a time.".into());
        }
        paths
            .into_iter()
            .map(|selected| {
                let path = selected.into_path().map_err(error)?;
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .ok_or("The filename is not valid Unicode")?
                    .to_string();
                let (file, size, modified) = source(&path).map_err(error)?;
                Ok((
                    Job::Upload {
                        file,
                        parent: parent.clone(),
                        name: name.clone(),
                        size,
                        modified,
                    },
                    name,
                    size,
                    "upload",
                ))
            })
            .collect()
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
fn download_destinations(folder: &Path, names: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut unique = std::collections::HashSet::new();
    names.iter().map(|name| {
        download_name(name)?;
        // Conservative on every client: never let case aliases overwrite each other.
        if !unique.insert(name.to_lowercase()) { return Err("Selected filenames conflict on this computer. Download them individually with different names.".into()); }
        let path = folder.join(name);
        if path.symlink_metadata().is_ok() { return Err(format!("{} already exists. Choose a different folder; nothing was replaced.", path.display())); }
        Ok(path)
    }).collect()
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
        || files.len() > 16
        || files
            .iter()
            .any(|file| file.path.is_empty() || file.revision.is_empty())
    {
        return Err("Choose between 1 and 16 versioned files at a time.".into());
    }
    let service = provider(&state, session_id, binding.as_ref()).await?;
    let mut names = Vec::new();
    let mut trees = Vec::new();
    for file in &files {
        let tree = remote_tree(&service, file).await?;
        download_name(&tree.root.entry.name)?;
        names.push(tree.root.entry.name.clone());
        trees.push(tree);
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
    let folder = destination.into_path().map_err(error)?;
    let destinations = download_destinations(&folder, &names)?;
    let jobs = trees
        .into_iter()
        .zip(names)
        .zip(destinations)
        .map(|((tree, name), destination)| {
            let size = tree.root.entry.size;
            let job = if tree.root.entry.kind == "directory" {
                Job::Tree {
                    tree,
                    target: tree::Target::Local(destination),
                }
            } else {
                let entry = &tree.root.entry;
                Job::Download {
                    destination,
                    path: entry.path.clone(),
                    revision: entry.revision.clone(),
                }
            };
            (job, name, size, "download")
        })
        .collect();
    let registry = state.registry.lock().await;
    registry
        .sessions
        .get(&session_id)
        .ok_or("The host disconnected during preparation")?
        .check_source(&ServiceRole::Files, binding.as_ref())?;
    state.transfers.lock().await.add(session_id, service, jobs)
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
        let remote = RemoteClipboardSelection { owner: session, service: service.clone(), catalog: catalog.clone() };
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
fn clipboard_uploads(
    paths: Vec<PathBuf>,
    parent: String,
) -> Result<Vec<(Job, String, u64, &'static str)>, String> {
    if paths.is_empty() {
        return Err("Copy files or folders first.".into());
    }
    let roots = Arc::new(catalog::Catalog::new(false).map_err(error)?);
    let count = paths.len();
    for path in paths {
        if !path.is_absolute() {
            return Err("Clipboard paths must be absolute".into());
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
        format!("{count} clipboard items")
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
    on_event: Channel<Progress>,
    state: State<'_, DesktopState>,
) -> Result<u32, String> {
    #[cfg(not(windows))]
    {
        let _ = (
            session_id, binding, path, revision, operation, on_event, state,
        );
        Err("File clipboard integration is currently available on Windows".into())
    }
    #[cfg(windows)]
    {
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
                )
                .await;
            }
        }
        let sequence = crate::windows_file_input::sequence();
        let fs = crate::filesystem(&state, session_id, binding.as_ref()).await?;
        let location = fs.locate(&path).await.map_err(error)?;
        let parent = location.parent.ok_or("Cannot cut a filesystem root")?;
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
        crate::windows_clipboard::publish(Vec::new(), sequence).await
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
    state: State<'_, DesktopState>,
) -> Result<Outcome, String> {
    let ClaimedTransfer {
        job,
        service,
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
        execute(job, service, &cancel, &mut |event| {
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
    }
    .await;
    state.transfers.lock().await.jobs.remove(&transfer_id);
    Ok(match result {
        Ok(path) => Outcome {
            status: "completed",
            bytes: last.bytes,
            total: last.total,
            message: None,
            path: Some(path),
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
            }
        }
    })
}
