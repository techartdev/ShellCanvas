// SPDX-License-Identifier: MPL-2.0
use crate::{
    connection_resource::ConnectionResource, workspace_services::ServiceRole, DesktopState,
};
use shellcanvas_services::{
    ConnectionIdentity, DirectoryPage, DirectoryReader, FileSystemProvider, DIRECTORY_PAGE,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tauri::{State, WebviewWindow};
use tokio::sync::{mpsc, oneshot, watch, OwnedSemaphorePermit, Semaphore};

const CAPACITY: usize = 32;
const DEADLINE: Duration = Duration::from_secs(30);
#[cfg(test)]
#[path = "directories_tests.rs"]
mod tests;
type Outcome = Result<(), String>;
struct Request {
    reply: oneshot::Sender<Result<DirectoryPage, String>>,
    _permit: OwnedSemaphorePermit,
}
struct Control {
    requests: mpsc::Sender<Request>,
    reading: Arc<Semaphore>,
    canceled: watch::Sender<bool>,
    complete: watch::Receiver<Option<Outcome>>,
    held: Mutex<Option<OwnedSemaphorePermit>>,
}
impl Control {
    async fn next(&self) -> Result<DirectoryPage, String> {
        if *self.canceled.borrow() {
            return Err("Directory reader is closed".into());
        }
        let permit = self
            .reading
            .clone()
            .try_acquire_owned()
            .map_err(|_| "A directory page is already being read")?;
        let (reply, result) = oneshot::channel();
        self.requests
            .try_send(Request {
                reply,
                _permit: permit,
            })
            .map_err(|_| "Directory reader is closed")?;
        result.await.map_err(|_| "Directory reader is closed")?
    }
    fn cancel(&self) {
        self.canceled.send_replace(true);
    }
    async fn close(&self) -> Outcome {
        self.cancel();
        let mut complete = self.complete.clone();
        loop {
            if let Some(result) = complete.borrow_and_update().clone() {
                return result;
            }
            complete
                .changed()
                .await
                .map_err(|_| "Directory cleanup could not be confirmed")?;
        }
    }
}
struct Record {
    owner: String,
    session: u64,
    source: ConnectionIdentity,
    lifetime: Weak<ConnectionResource>,
    control: Arc<Control>,
}
struct Inner {
    records: Mutex<HashMap<String, Record>>,
    slots: Arc<Semaphore>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        for record in self.records.get_mut().unwrap().values() {
            record.control.cancel();
        }
    }
}
#[derive(Clone)]
pub struct DirectoryReaders(Arc<Inner>);
impl Default for DirectoryReaders {
    fn default() -> Self {
        Self(Arc::new(Inner {
            records: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(CAPACITY)),
        }))
    }
}
impl DirectoryReaders {
    fn begin(
        &self,
        owner: &str,
        session: u64,
        source: &Arc<ConnectionResource>,
        provider: Arc<dyn FileSystemProvider>,
        path: Option<String>,
    ) -> Result<String, String> {
        let mut records = self.0.records.lock().unwrap();
        // Failed cleanup keeps its capacity charged until the physical source
        // is disconnected. Removing a UI window cannot discard that obligation.
        records.retain(|_, record| {
            record.control.held.lock().unwrap().is_none()
                || record
                    .lifetime
                    .upgrade()
                    .is_some_and(|source| source.is_connected())
        });
        let permit = self
            .0
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| "Close an existing directory reader before opening another")?;
        let id = uuid::Uuid::new_v4().to_string();
        let (requests, receive) = mpsc::channel(1);
        let (canceled, cancellation) = watch::channel(false);
        let (completed, complete) = watch::channel(None);
        let control = Arc::new(Control {
            requests,
            reading: Arc::new(Semaphore::new(1)),
            canceled,
            complete,
            held: Mutex::new(None),
        });
        records.insert(
            id.clone(),
            Record {
                owner: owner.into(),
                session,
                source: source.identity().clone(),
                lifetime: Arc::downgrade(source),
                control: control.clone(),
            },
        );
        let registry = Arc::downgrade(&self.0);
        let running_id = id.clone();
        tokio::spawn(async move {
            let cleanup = tokio::spawn(run(provider, path, receive, cancellation))
                .await
                .unwrap_or_else(|_| {
                    Err("Directory worker failed; cleanup could not be confirmed".into())
                });
            if cleanup.is_err() {
                *control.held.lock().unwrap() = Some(permit);
            } else {
                drop(permit);
            }
            completed.send_replace(Some(cleanup.clone()));
            if cleanup.is_ok() {
                if let Some(registry) = registry.upgrade() {
                    registry.records.lock().unwrap().remove(&running_id);
                }
            }
        });
        Ok(id)
    }
    fn lookup(
        &self,
        owner: &str,
        session: u64,
        id: &str,
    ) -> Result<Option<(Arc<Control>, ConnectionIdentity)>, String> {
        self.0
            .records
            .lock()
            .unwrap()
            .get(id)
            .map(|record| {
                if record.owner != owner || record.session != session {
                    return Err("Directory reader belongs to another window or workspace".into());
                }
                Ok((record.control.clone(), record.source.clone()))
            })
            .transpose()
    }
    pub fn close_session(&self, session: u64) {
        for record in self
            .0
            .records
            .lock()
            .unwrap()
            .values()
            .filter(|record| record.session == session)
        {
            record.control.cancel();
        }
    }
    pub fn close_source(&self, session: u64, source: &ConnectionIdentity) {
        for record in self
            .0
            .records
            .lock()
            .unwrap()
            .values()
            .filter(|record| record.session == session && &record.source == source)
        {
            record.control.cancel();
        }
    }
    pub fn close_owner(&self, owner: &str) {
        for record in self
            .0
            .records
            .lock()
            .unwrap()
            .values()
            .filter(|record| record.owner == owner)
        {
            record.control.cancel();
        }
    }
}
async fn run(
    provider: Arc<dyn FileSystemProvider>,
    path: Option<String>,
    mut requests: mpsc::Receiver<Request>,
    mut canceled: watch::Receiver<bool>,
) -> Outcome {
    let mut reader: Option<Box<dyn DirectoryReader>> = None;
    let mut final_reply = None;
    let mut uncertain_open = false;
    loop {
        if *canceled.borrow() {
            break;
        }
        let request = tokio::select! { biased;
            _ = canceled.changed() => break,
            request = requests.recv() => match request { Some(request) => request, None => break },
        };
        if request.reply.is_closed() {
            break;
        }
        if reader.is_none() {
            // Preserve late-open ownership after cancellation. The UI is free to
            // stop awaiting, but the worker/permit survives until close completes.
            match tokio::time::timeout(DEADLINE, provider.clone().open_directory(path.as_deref()))
                .await
            {
                Ok(Ok(opened)) => reader = Some(opened),
                result => {
                    uncertain_open = result.is_err();
                    let error = match result {
                        Ok(Err(error)) => format!("{error:#}"),
                        _ => "Directory opening timed out; cleanup could not be confirmed".into(),
                    };
                    final_reply = Some((request, Err(error)));
                    break;
                }
            }
        }
        let result = if *canceled.borrow() { Err("Directory listing canceled".into()) } else {
            tokio::select! { biased;
                _ = canceled.changed() => Err("Directory listing canceled".into()),
                result = tokio::time::timeout(DEADLINE, reader.as_mut().unwrap().next()) => {
                    result.map_err(|_| "Directory page timed out".to_string()).and_then(|result| result.map_err(|error| format!("{error:#}")))
                }
            }
        }.and_then(|page| {
            if page.directory.path.is_empty() || page.directory.entries.len() > DIRECTORY_PAGE || (!page.done && page.directory.entries.is_empty()) { Err("Invalid directory page".into()) } else { Ok(page) }
        });
        if !result.as_ref().is_ok_and(|page| !page.done) {
            final_reply = Some((request, result));
            break;
        }
        if request.reply.send(result).is_err() {
            break;
        }
    }
    requests.close();
    let cleanup = if let Some(mut reader) = reader {
        tokio::time::timeout(DEADLINE, reader.close())
            .await
            .map_err(|_| "Directory cleanup timed out".to_string())
            .and_then(|result| result.map_err(|error| format!("{error:#}")))
    } else if uncertain_open {
        Err("Directory opening timed out; cleanup could not be confirmed".into())
    } else {
        Ok(())
    };
    if let Some((request, result)) = final_reply {
        let result = if let Err(error) = &cleanup {
            Err(format!("Directory cleanup could not be confirmed: {error}"))
        } else {
            result
        };
        let _ = request.reply.send(result);
    }
    cleanup
}

#[tauri::command]
pub async fn open_directory(
    session_id: u64,
    binding: Option<ConnectionIdentity>,
    path: Option<String>,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<String, String> {
    let sessions = state.registry.lock().await;
    let workspace = sessions
        .sessions
        .get(&session_id)
        .ok_or("Workspace is closed")?;
    workspace.check_source(&ServiceRole::Files, binding.as_ref())?;
    let provider = workspace
        .files
        .clone()
        .ok_or("File browsing is unavailable")?;
    let source = workspace
        .service_connection(&ServiceRole::Files)
        .ok_or("File source is unavailable")?;
    state
        .directories
        .begin(window.label(), session_id, &source, provider, path)
}
#[tauri::command]
pub async fn read_directory(
    session_id: u64,
    directory_id: String,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Result<DirectoryPage, String> {
    let (control, source) = state
        .directories
        .lookup(window.label(), session_id, &directory_id)?
        .ok_or("Directory reader is closed")?;
    if let Err(error) = crate::filesystem(&state, session_id, Some(&source)).await {
        control.cancel();
        return Err(error);
    }
    let result = control.next().await;
    if let Err(error) = crate::filesystem(&state, session_id, Some(&source)).await {
        control.cancel();
        return Err(error);
    }
    result
}
#[tauri::command]
pub async fn close_directory(
    session_id: u64,
    directory_id: String,
    window: WebviewWindow,
    state: State<'_, DesktopState>,
) -> Outcome {
    if let Some((control, _)) =
        state
            .directories
            .lookup(window.label(), session_id, &directory_id)?
    {
        control.close().await?;
    }
    Ok(())
}
