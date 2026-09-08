// SPDX-License-Identifier: MPL-2.0
use crate::{error, DesktopState};
use anyhow::{bail, Context, Result};
use serde::Serialize;
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
#[path = "transfer_tests.rs"]
mod tests;

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
    state: State<'_, DesktopState>,
) -> Result<Vec<Ticket>, String> {
    provider(&state, session_id).await?;
    let jobs = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<_>, String> {
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
#[tauri::command]
pub async fn cancel_transfer(
    session_id: u64,
    transfer_id: u64,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    state.transfers.lock().await.cancel(session_id, transfer_id)
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
                status: if message == "Transfer canceled" {
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
