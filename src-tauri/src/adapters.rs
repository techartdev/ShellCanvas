// SPDX-License-Identifier: MPL-2.0
use shellcanvas_adapter_runtime::catalog::{AdapterInfo, Catalog, Review};
use shellcanvas_services::{ConnectionIdentity, HostInfo};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdapterSource {
    pub key: String,
    pub id: String,
    pub revision: String,
    pub configuration: serde_json::Value,
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdapterConnectionOptions {
    pub name: String,
    pub sources: Vec<AdapterSource>,
    pub bindings: HashMap<String, String>,
}
impl AdapterConnectionOptions {
    fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty()
            || self.name.len() > 200
            || self.sources.is_empty()
            || self.bindings.is_empty()
        {
            return Err("Choose a workspace name and at least one connection service".into());
        }
        let keys: std::collections::HashSet<_> =
            self.sources.iter().map(|source| &source.key).collect();
        if keys.len() != self.sources.len()
            || self
                .sources
                .iter()
                .any(|source| source.key.is_empty() || source.key.len() > 100)
        {
            return Err("Connection source identities must be unique".into());
        }
        if self.bindings.iter().any(|(role, key)| {
            (!["files", "console", "host.settings"].contains(&role.as_str())
                && !shellcanvas_services::custom_service_id(role))
                || !keys.contains(key)
        }) || self
            .sources
            .iter()
            .any(|source| !self.bindings.values().any(|key| *key == source.key))
        {
            return Err("Choose explicit service sources for this workspace".into());
        }
        Ok(())
    }
}
#[tauri::command]
pub async fn connect_adapters(
    options: AdapterConnectionOptions,
    request_id: u64,
    app: tauri::AppHandle,
    state: State<'_, crate::DesktopState>,
) -> Result<crate::SessionInfo, String> {
    options.validate()?;
    let canceled = state.attempts.lock().await.claim(request_id)?;
    let result =
        crate::connection_attempts::cancellable(canceled, connect_workspace(options, app, &state))
            .await;
    state.attempts.lock().await.finish(request_id);
    result
}
async fn connect_workspace(
    options: AdapterConnectionOptions,
    app: tauri::AppHandle,
    state: &crate::DesktopState,
) -> Result<crate::SessionInfo, String> {
    let (active, info) = prepare_workspace(options, app, state).await?;
    let connections = active.identities();
    let status = active.status();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    state.registry.lock().await.sessions.insert(id, active);
    Ok(crate::SessionInfo {
        id,
        info,
        connections,
        services: status.services,
        custom_sources: status.custom_sources,
        source_revision: status.source_revision,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceReplacement {
    #[serde(flatten)]
    status: crate::workspace_services::WorkspaceStatus,
    connections: Vec<ConnectionIdentity>,
    cleanup_warning: Option<String>,
}

#[tauri::command]
pub async fn replace_adapter_source(
    session_id: u64,
    expected: ConnectionIdentity,
    options: AdapterConnectionOptions,
    request_id: u64,
    app: tauri::AppHandle,
    state: State<'_, crate::DesktopState>,
) -> Result<SourceReplacement, String> {
    options.validate()?;
    if options.sources.len() != 1 {
        return Err("Replace one connection source at a time".into());
    }
    let canceled = state.attempts.lock().await.claim(request_id)?;
    // Only preparation/lock acquisition is cancelable. Once committed, a late
    // cancel cannot hide the accepted result or disconnect the whole workspace.
    let prepared = crate::connection_attempts::cancellable(
        canceled.clone(),
        prepare_workspace(options, app, &state),
    )
    .await;
    let result = async {
        let (candidate, _) = prepared?;
        let mut registry = crate::connection_attempts::cancellable(canceled.clone(), async {
            Ok(state.registry.lock().await)
        })
        .await?;
        let mut transfers = crate::connection_attempts::cancellable(canceled.clone(), async {
            Ok(state.transfers.lock().await)
        })
        .await?;
        if *canceled.borrow() {
            return Err("Connection canceled".into());
        }
        let workspace = registry
            .sessions
            .get_mut(&session_id)
            .ok_or("Workspace is closed")?;
        let replaces_files =
            workspace.is_source_for(&expected, &crate::workspace_services::ServiceRole::Files);
        let retired = workspace.replace_source(&expected, candidate)?;
        if replaces_files {
            transfers.close_session(session_id);
        }
        let mut result = SourceReplacement {
            status: workspace.status(),
            connections: workspace.identities(),
            cleanup_warning: None,
        };
        drop(transfers);
        drop(registry);
        result.cleanup_warning = retired.close().await.err().map(|error| {
            format!("Connection replaced, but closing the previous connection failed: {error}")
        });
        Ok(result)
    }
    .await;
    state.attempts.lock().await.finish(request_id);
    result
}

async fn prepare_workspace(
    options: AdapterConnectionOptions,
    app: tauri::AppHandle,
    state: &crate::DesktopState,
) -> Result<(crate::workspace_services::WorkspaceServices, HostInfo), String> {
    let catalog = catalog(&app)?;
    let mut connections = Vec::new();
    for source in options.sources {
        let catalog = catalog.clone();
        let lease = tauri::async_runtime::spawn_blocking(move || {
            let lease = catalog
                .acquire(&source.id, &source.revision)
                .map_err(|error| error.to_string())?;
            let config = lease
                .configuration(&source.configuration)
                .map_err(|error| error.to_string())?;
            Ok::<_, String>((source.key, lease, config))
        })
        .await
        .map_err(|error| error.to_string())??;
        let (key, lease, config) = lease;
        let identity = ConnectionIdentity {
            instance: state.next_id.fetch_add(1, Ordering::Relaxed) + 1,
            generation: 1,
            adapter: lease.info.id.clone(),
        };
        let process = lease
            .connect(&config, Duration::from_secs(30))
            .await
            .map_err(|error| error.to_string())?;
        let files = process.files();
        let terminal = process.terminal();
        let lifecycle = Arc::new(process.clone());
        let resource = crate::connection_resource::ConnectionResource::new(identity, lifecycle);
        connections.push((key, resource, files, terminal, process));
    }
    let mut active = crate::workspace_services::WorkspaceServices::new(
        connections
            .iter()
            .map(|(_, resource, _, _, _)| resource.clone())
            .collect(),
    )?;
    let mut capabilities = Vec::new();
    let mut notices = Vec::new();
    for (role, key) in &options.bindings {
        let (_, resource, files, terminal, process) = connections
            .iter()
            .find(|(id, _, _, _, _)| id == key)
            .ok_or("Missing connection source")?;
        match role.as_str() {
            "files" => {
                active.select_service(resource, crate::workspace_services::ServiceRole::Files)?;
                if let Some(files) = files {
                    active.bind_files(resource, files.clone())?;
                    capabilities.push("files.read".into());
                    if let Some(text) = process.text() {
                        active.bind_text(resource, text)?;
                        if process.supports("files", 1, &["files.createText"]) {
                            capabilities.push("files.create".into());
                        }
                        if process.supports("files", 1, &["files.saveText"]) {
                            capabilities.push("files.edit".into());
                        }
                    }
                    if let Some(mutations) = process.mutations() {
                        active.bind_mutations(resource, mutations)?;
                        capabilities.push("files.manage".into());
                    }
                    if let Some(moves) = process.moves() {
                        active.bind_moves(resource, moves)?;
                        capabilities.push("files.move".into());
                    }
                } else {
                    notices.push(
                        "File browsing is unavailable through the selected connection.".into(),
                    );
                }
            }
            "console" => {
                active.select_service(resource, crate::workspace_services::ServiceRole::Console)?;
                if let Some(terminal) = terminal {
                    active.bind_terminal(resource, terminal.clone())?;
                    capabilities.push("terminal".into());
                } else {
                    notices
                        .push("A terminal is unavailable through the selected connection.".into());
                }
            }
            "host.settings" => {
                active.select_service(
                    resource,
                    crate::workspace_services::ServiceRole::HostSettings,
                )?;
                if let Some(settings) = process.settings() {
                    active.bind_settings(resource, settings)?;
                    capabilities.push("host.settings".into());
                } else {
                    notices.push(
                        "Remote settings are unavailable through the selected connection.".into(),
                    );
                }
            }
            custom => {
                let service = process.custom(custom).ok_or_else(|| {
                    format!("The selected adapter does not advertise service {custom}")
                })?;
                active.bind_custom(resource, service)?;
            }
        }
    }
    active.advertise_capabilities(&capabilities);
    let info = HostInfo {
        provider: "adapters".into(),
        system: "Adapter workspace".into(),
        hostname: options.name,
        home: None,
        capabilities,
        notices,
    };
    Ok((active, info))
}

struct Job {
    owner: String,
    started: Instant,
    canceled: Arc<AtomicBool>,
    running: bool,
    review: Option<Review>,
}
#[derive(Clone, Default)]
pub struct AdapterJobs {
    jobs: Arc<Mutex<HashMap<String, Job>>>,
}
impl AdapterJobs {
    fn prune(jobs: &mut HashMap<String, Job>) {
        jobs.retain(|_, job| {
            if job.started.elapsed() > Duration::from_secs(600) {
                job.canceled.store(true, Ordering::Release);
                false
            } else {
                true
            }
        });
    }
    fn begin(&self, id: &str, owner: &str) -> Result<Arc<AtomicBool>, String> {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid adapter review identity")?;
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| "Adapter review state unavailable")?;
        Self::prune(&mut jobs);
        if let Some(job) = jobs.get(id) {
            return Err(
                if job.owner == owner && job.canceled.load(Ordering::Acquire) {
                    "Adapter review canceled"
                } else {
                    "Adapter review identity is already in use"
                }
                .into(),
            );
        }
        if jobs.len() >= 64 {
            return Err("Close an existing adapter review before starting another".into());
        }
        let canceled = Arc::new(AtomicBool::new(false));
        jobs.insert(
            id.into(),
            Job {
                owner: owner.into(),
                started: Instant::now(),
                canceled: canceled.clone(),
                running: true,
                review: None,
            },
        );
        Ok(canceled)
    }
    fn finish(&self, id: &str, owner: &str, review: Review) -> Result<(), String> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| "Adapter review state unavailable")?;
        let job = jobs
            .get_mut(id)
            .filter(|job| job.owner == owner)
            .ok_or("Adapter review canceled")?;
        if job.canceled.load(Ordering::Acquire) {
            jobs.remove(id);
            return Err("Adapter review canceled".into());
        }
        job.running = false;
        job.review = Some(review);
        Ok(())
    }
    fn forget(&self, id: &str, owner: &str) {
        if let Ok(mut jobs) = self.jobs.lock() {
            if jobs.get(id).is_some_and(|job| job.owner == owner) {
                jobs.remove(id);
            }
        }
    }
    fn cancel(&self, id: &str, owner: &str) -> Result<(), String> {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid adapter review identity")?;
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| "Adapter review state unavailable")?;
        Self::prune(&mut jobs);
        if let Some(job) = jobs.get_mut(id) {
            if job.owner != owner {
                return Err("This adapter review belongs to another window".into());
            }
            job.canceled.store(true, Ordering::Release);
            job.review = None;
        } else if jobs.len() < 64 {
            // Cancellation can arrive before its asynchronous review command is scheduled.
            jobs.insert(
                id.into(),
                Job {
                    owner: owner.into(),
                    started: Instant::now(),
                    canceled: Arc::new(AtomicBool::new(true)),
                    running: false,
                    review: None,
                },
            );
        }
        Ok(())
    }
    fn take(&self, id: &str, owner: &str) -> Result<Review, String> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| "Adapter review state unavailable")?;
        Self::prune(&mut jobs);
        let job = jobs
            .get_mut(id)
            .filter(|job| {
                job.owner == owner && !job.running && !job.canceled.load(Ordering::Acquire)
            })
            .ok_or("Adapter review expired or belongs to another window")?;
        let review = job
            .review
            .take()
            .ok_or("Adapter review was already consumed")?;
        jobs.remove(id);
        Ok(review)
    }
}
pub fn catalog(app: &tauri::AppHandle) -> Result<Catalog, String> {
    Ok(Catalog::new(
        app.path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?
            .join("adapters"),
    ))
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterReview {
    request_id: String,
    package: AdapterInfo,
    replaces: bool,
}
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn review_fixture_adapter(
    request_id: String,
    version: u8,
    window: WebviewWindow,
    state: State<'_, AdapterJobs>,
) -> Result<AdapterReview, String> {
    let app = window.app_handle();
    if app.config().identifier != "dev.shellcanvas.extensionprobe"
        || std::env::var("SHELLCANVAS_EXTENSION_PROBE").as_deref() != Ok("1")
        || ![1, 2].contains(&version)
    {
        return Err("This command is available only to the adapter probe".into());
    }
    let catalog = catalog(app)?;
    let owner = window.label().to_string();
    let jobs = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let canceled = jobs.begin(&request_id, &owner)?;
        let path = std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(format!(
                ".local/native-adapter-probe/packages/v{version}/adapter.json"
            ));
        let review = catalog
            .review(&path, &canceled)
            .map_err(|error| error.to_string())?;
        let response = AdapterReview {
            request_id: request_id.clone(),
            package: review.info(),
            replaces: review.replaces(),
        };
        jobs.finish(&request_id, &owner, review)?;
        Ok(response)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn list_adapters(app: tauri::AppHandle) -> Result<Vec<AdapterInfo>, String> {
    let catalog = catalog(&app)?;
    tauri::async_runtime::spawn_blocking(move || catalog.list().map_err(|error| error.to_string()))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn review_adapter(
    request_id: String,
    window: WebviewWindow,
    state: State<'_, AdapterJobs>,
) -> Result<Option<AdapterReview>, String> {
    let jobs = state.inner().clone();
    let owner = window.label().to_string();
    let app = window.app_handle().clone();
    let catalog = catalog(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let canceled = jobs.begin(&request_id, &owner)?;
        let result = (|| {
            let selected = app
                .dialog()
                .file()
                .set_title("Choose an adapter manifest")
                .add_filter("ShellCanvas adapter manifest", &["json"])
                .blocking_pick_file();
            let Some(selected) = selected else {
                return Ok(None);
            };
            let path = selected
                .into_path()
                .map_err(|_| "Choose a local adapter manifest")?;
            let reviewed = catalog
                .review(&path, &canceled)
                .map_err(|error| error.to_string())?;
            let result = AdapterReview {
                request_id: request_id.clone(),
                package: reviewed.info(),
                replaces: reviewed.replaces(),
            };
            jobs.finish(&request_id, &owner, reviewed)?;
            Ok(Some(result))
        })();
        if !matches!(&result, Ok(Some(_))) {
            jobs.forget(&request_id, &owner);
        }
        result
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn cancel_adapter_review(
    request_id: String,
    window: WebviewWindow,
    state: State<'_, AdapterJobs>,
) -> Result<(), String> {
    let jobs = state.inner().clone();
    let owner = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || jobs.cancel(&request_id, &owner))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn install_adapter(
    request_id: String,
    window: WebviewWindow,
    state: State<'_, AdapterJobs>,
) -> Result<AdapterInfo, String> {
    let jobs = state.inner().clone();
    let owner = window.label().to_string();
    let catalog = catalog(window.app_handle())?;
    tauri::async_runtime::spawn_blocking(move || {
        let info = catalog
            .install(jobs.take(&request_id, &owner)?)
            .map_err(|error| error.to_string())?;
        let _ = catalog.collect();
        Ok(info)
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn set_adapter_enabled(
    id: String,
    revision: String,
    enabled: bool,
    app: tauri::AppHandle,
) -> Result<AdapterInfo, String> {
    let catalog = catalog(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        catalog
            .set_enabled(&id, &revision, enabled)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn remove_adapter(
    id: String,
    revision: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let catalog = catalog(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        catalog
            .remove(&id, &revision)
            .map_err(|error| error.to_string())?;
        let _ = catalog.collect();
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn review_cancellation_is_window_owned_and_can_precede_start() {
        let jobs = AdapterJobs::default();
        let id = uuid::Uuid::new_v4().to_string();
        jobs.cancel(&id, "main").unwrap();
        assert!(jobs.begin(&id, "main").is_err());
        assert!(jobs.cancel(&id, "foreign").is_err());
        let id = uuid::Uuid::new_v4().to_string();
        let flag = jobs.begin(&id, "main").unwrap();
        assert!(jobs.cancel(&id, "foreign").is_err());
        assert!(!flag.load(Ordering::Acquire));
        jobs.cancel(&id, "main").unwrap();
        assert!(flag.load(Ordering::Acquire));
        assert!(jobs.take(&id, "main").is_err());
    }
}
