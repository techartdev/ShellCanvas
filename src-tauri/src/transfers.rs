// SPDX-License-Identifier: MPL-2.0
use crate::{error, DesktopState};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use shellcanvas_core::{FileTransferService, TRANSFER_CHUNK};
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

#[cfg(test)]
#[path = "transfer_folder_tests.rs"]
mod folder_tests;
#[cfg(test)]
#[path = "transfer_tests.rs"]
mod tests;
#[path = "transfer_tree.rs"]
mod tree;

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
    job: Option<Job>,
    cancel: watch::Sender<bool>,
}
pub struct TransferRegistry {
    next: u64,
    jobs: HashMap<u64, Pending>,
    slots: Arc<Semaphore>,
}
impl Default for TransferRegistry {
    fn default() -> Self {
        Self {
            next: 0,
            jobs: HashMap::new(),
            slots: Arc::new(Semaphore::new(4)),
        }
    }
}
impl TransferRegistry {
    fn add(
        &mut self,
        owner: u64,
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
    fn claim(
        &mut self,
        owner: u64,
        id: u64,
    ) -> Result<(Job, watch::Receiver<bool>, Arc<Semaphore>), String> {
        let pending = self
            .jobs
            .get_mut(&id)
            .filter(|p| p.owner == owner)
            .ok_or("Transfer is closed or belongs to another host")?;
        let job = pending.job.take().ok_or("Transfer already started")?;
        Ok((job, pending.cancel.subscribe(), self.slots.clone()))
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
) -> Result<Arc<dyn FileTransferService>, String> {
    state
        .registry
        .lock()
        .await
        .sessions
        .get(&session)
        .and_then(|s| s.transfers.clone())
        .ok_or("File transfers are unavailable on this host".into())
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
    parent: String,
    folder: Option<bool>,
    state: State<'_, DesktopState>,
) -> Result<Vec<Ticket>, String> {
    provider(&state, session_id).await?;
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
    if !registry.sessions.contains_key(&session_id) {
        return Err("The host disconnected while selecting files".into());
    }
    state.transfers.lock().await.add(session_id, jobs)
}
#[tauri::command]
pub async fn choose_download_file(
    app: tauri::AppHandle,
    session_id: u64,
    path: String,
    revision: String,
    state: State<'_, DesktopState>,
) -> Result<Option<Ticket>, String> {
    provider(&state, session_id).await?;
    let location = crate::filesystem(&state, session_id)
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
    if !registry.sessions.contains_key(&session_id) {
        return Err("The host disconnected while choosing a destination".into());
    }
    let mut tickets = state.transfers.lock().await.add(
        session_id,
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
    provider(&state, session_id).await?;
    let mut names = Vec::new();
    let mut trees = Vec::new();
    for file in &files {
        let tree = remote_tree(&state, session_id, file).await?;
        tree.local_names().map_err(error)?;
        names.push(tree.nodes[0].entry.name.clone());
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
            let size = tree.size;
            let job = if tree.nodes[0].entry.kind == "directory" {
                Job::Tree {
                    tree,
                    target: tree::Target::Local(destination),
                }
            } else {
                let entry = &tree.nodes[0].entry;
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
    if !registry.sessions.contains_key(&session_id) {
        return Err("The host disconnected while choosing a destination".into());
    }
    state.transfers.lock().await.add(session_id, jobs)
}

async fn remote_tree(
    state: &DesktopState,
    session: u64,
    file: &DownloadSource,
) -> Result<tree::Tree, String> {
    let service = provider(state, session).await?;
    let fs = crate::filesystem(state, session).await?;
    let location = fs.locate(&file.path).await.map_err(error)?;
    let parent = location
        .parent
        .ok_or("Select a file or folder, not a filesystem root")?;
    let entry = fs
        .list(Some(&parent))
        .await
        .map_err(error)?
        .entries
        .into_iter()
        .find(|entry| {
            entry.path == file.path && !file.revision.is_empty() && entry.revision == file.revision
        })
        .ok_or("The selected item changed. Refresh and select it again.")?;
    tree::remote(&service, entry).await.map_err(error)
}
#[cfg(windows)]
fn clipboard_sources(
    tree: tree::Tree,
    service: Arc<dyn FileTransferService>,
) -> Result<Vec<crate::clipboard_stream::Source>, String> {
    let names = tree.local_names().map_err(error)?;
    tree.nodes.into_iter().zip(names).map(|(node, name)| {
        let display_path = name.to_string_lossy().replace('/', "\\");
        if display_path.encode_utf16().count() >= 260 { return Err("A folder path is too long for Explorer's file clipboard (259 characters). Use Download instead.".into()); }
        Ok(crate::clipboard_stream::Source { entry: node.entry, display_path, service: service.clone(), runtime: tokio::runtime::Handle::current() })
    }).collect()
}
#[tauri::command]
pub async fn copy_system_files(
    session_id: u64,
    files: Vec<DownloadSource>,
    state: State<'_, DesktopState>,
) -> Result<u32, String> {
    #[cfg(not(windows))]
    {
        let _ = (session_id, files, state);
        Err("File clipboard integration is currently available on Windows.".into())
    }
    #[cfg(windows)]
    {
        let sequence = crate::windows_file_input::sequence();
        if files.is_empty() || files.len() > 16 {
            return Err("Select up to 16 files or folders.".into());
        }
        let service = provider(&state, session_id).await?;
        let mut names = std::collections::HashSet::new();
        let mut sources = Vec::new();
        for file in files {
            let tree = remote_tree(&state, session_id, &file).await?;
            if !names.insert(tree.nodes[0].entry.name.to_lowercase()) {
                return Err("Selected names conflict in Explorer".into());
            }
            if sources.len() + tree.nodes.len() > tree::MAX_ENTRIES {
                return Err("Copy up to 1024 files and folders at a time".into());
            }
            sources.extend(clipboard_sources(tree, service.clone())?);
        }
        if !state
            .registry
            .lock()
            .await
            .sessions
            .contains_key(&session_id)
        {
            return Err("The host disconnected while copying".into());
        }
        crate::windows_clipboard::publish(sources, sequence).await
    }
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

// Retain opened local handles before returning any tickets. No path supplied by JS.
fn clipboard_uploads(
    paths: Vec<PathBuf>,
    parent: String,
) -> Result<Vec<(Job, String, u64, &'static str)>, String> {
    if paths.is_empty() || paths.len() > 16 {
        return Err("Copy up to 16 files or folders at a time.".into());
    }
    let mut names = std::collections::HashSet::new();
    let mut count = 0;
    paths
        .into_iter()
        .map(|path| {
            if !path.is_absolute() {
                return Err("Clipboard paths must be absolute".into());
            }
            let mut tree = tree::local(path).map_err(error)?;
            count += tree.nodes.len();
            if count > tree::MAX_ENTRIES {
                return Err("Copy up to 1024 files and folders at a time".into());
            }
            let name = tree.nodes[0].entry.name.clone();
            let size = tree.size;
            if !names.insert(name.clone()) {
                return Err("Copied items have duplicate names. Paste them separately.".into());
            }
            let job = if tree.nodes[0].entry.kind == "file" {
                let (file, modified) = tree.nodes[0].local.take().unwrap();
                Job::Upload {
                    file,
                    parent: parent.clone(),
                    name: name.clone(),
                    size,
                    modified,
                }
            } else {
                Job::Tree {
                    tree,
                    target: tree::Target::Remote(parent.clone()),
                }
            };
            Ok((job, name, size, "upload"))
        })
        .collect()
}

#[tauri::command]
pub async fn paste_system_files(
    session_id: u64,
    parent: String,
    state: State<'_, DesktopState>,
) -> Result<Option<Vec<Ticket>>, String> {
    #[cfg(not(windows))]
    {
        let _ = (session_id, parent, state);
        Err("File clipboard integration is currently available on Windows.".into())
    }
    #[cfg(windows)]
    {
        if parent.is_empty() {
            return Err("Choose a remote destination folder.".into());
        }
        provider(&state, session_id).await?;
        let jobs = tauri::async_runtime::spawn_blocking(move || {
            crate::windows_file_input::files()?
                .map(|paths| clipboard_uploads(paths, parent))
                .transpose()
        })
        .await
        .map_err(error)??;
        let Some(jobs) = jobs else {
            return Ok(None);
        };
        let registry = state.registry.lock().await;
        if !registry.sessions.contains_key(&session_id) {
            return Err("The host disconnected while preparing clipboard files.".into());
        }
        state.transfers.lock().await.add(session_id, jobs).map(Some)
    }
}

#[tauri::command]
pub async fn cut_system_file(
    session_id: u64,
    path: String,
    revision: String,
    state: State<'_, DesktopState>,
) -> Result<u32, String> {
    #[cfg(not(windows))]
    {
        let _ = (session_id, path, revision, state);
        Err("File clipboard integration is currently available on Windows.".into())
    }
    #[cfg(windows)]
    {
        let sequence = crate::windows_file_input::sequence();
        let fs = crate::filesystem(&state, session_id).await?;
        let location = fs.locate(&path).await.map_err(error)?;
        let parent = location.parent.ok_or("Cannot cut a filesystem root")?;
        let entry = fs
            .list(Some(&parent))
            .await
            .map_err(error)?
            .entries
            .into_iter()
            .find(|entry| {
                entry.path == location.path && !revision.is_empty() && entry.revision == revision
            })
            .ok_or("The selected item changed. Refresh and cut again.")?;
        let mut sources = Vec::new();
        if matches!(entry.kind.as_str(), "file" | "directory") {
            if let Ok(service) = provider(&state, session_id).await {
                sources = clipboard_sources(
                    tree::remote(&service, entry).await.map_err(error)?,
                    service,
                )?;
            }
        }
        if !state
            .registry
            .lock()
            .await
            .sessions
            .contains_key(&session_id)
        {
            return Err("The host disconnected while cutting.".into());
        }
        crate::windows_clipboard::publish(sources, sequence).await
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
    path: String,
    revision: String,
    parent: String,
    state: State<'_, DesktopState>,
) -> Result<Ticket, String> {
    if revision.is_empty() || parent.is_empty() {
        return Err("Refresh the file and choose a destination folder".into());
    }
    provider(&state, session_id).await?;
    let location = crate::filesystem(&state, session_id)
        .await?
        .locate(&path)
        .await
        .map_err(error)?;
    if location.parent.as_deref() == Some(parent.as_str()) {
        return Err("Choose a different destination folder".into());
    }
    let tree = remote_tree(
        &state,
        session_id,
        &DownloadSource {
            path: path.clone(),
            revision: revision.clone(),
        },
    )
    .await?;
    let destination = crate::filesystem(&state, session_id)
        .await?
        .locate(&parent)
        .await
        .map_err(error)?
        .path;
    if tree
        .nodes
        .iter()
        .any(|node| node.entry.kind == "directory" && node.entry.path == destination)
    {
        return Err("A folder cannot be copied into itself or a descendant".into());
    }
    let size = tree.size;
    let job = if tree.nodes[0].entry.kind == "directory" {
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
    if !registry.sessions.contains_key(&session_id) {
        return Err("The host disconnected while preparing the copy".into());
    }
    let name = location.name;
    let mut tickets = state
        .transfers
        .lock()
        .await
        .add(session_id, vec![(job, name, size, "copy")])?;
    tickets.pop().ok_or("Copy preparation failed".into())
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
                    progress(Progress { bytes: offset, total: size, phase: "running" });
                }
                let after = file.metadata().await?;
                if offset != size || after.len() != size || after.modified().ok() != modified { bail!("The local file changed during upload. The remote destination was not published."); }
                checkpoint(cancel)?;
                progress(Progress { bytes: offset,total: size,phase: "finishing" });
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
    let service = provider(&state, session_id).await?;
    let (job, mut cancel, slots) = state
        .transfers
        .lock()
        .await
        .claim(session_id, transfer_id)?;
    let mut last = Progress {
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
