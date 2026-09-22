// SPDX-License-Identifier: MPL-2.0
use sha2::{Digest, Sha256};
use shellcanvas_adapter_runtime::catalog::{AdapterInfo, Catalog, Manifest, Review};
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

struct PreparationObservation(shellcanvas_adapter_runtime::Diagnostics);
impl Drop for PreparationObservation {
    fn drop(&mut self) {
        self.0.preparation_canceled();
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdapterSource {
    pub key: String,
    pub id: String,
    pub revision: String,
    pub configuration: serde_json::Value,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdapterConnectionOptions {
    pub name: String,
    pub sources: Vec<AdapterSource>,
    pub bindings: HashMap<String, String>,
}
impl AdapterConnectionOptions {
    pub(crate) fn validate(&self) -> Result<(), String> {
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
    on_host_key: tauri::ipc::Channel<crate::connection_attempts::HostKeyChallenge>,
    app: tauri::AppHandle,
    state: State<'_, crate::DesktopState>,
    window: WebviewWindow,
) -> Result<crate::SessionInfo, String> {
    options.validate()?;
    let canceled = state.attempts.lock().await.claim(request_id)?;
    let result = crate::connection_attempts::cancellable(
        canceled,
        connect_workspace(
            options,
            request_id,
            on_host_key,
            app,
            &state,
            window.label(),
        ),
    )
    .await;
    state.attempts.lock().await.finish(request_id);
    result
}
async fn connect_workspace(
    options: AdapterConnectionOptions,
    request_id: u64,
    on_host_key: tauri::ipc::Channel<crate::connection_attempts::HostKeyChallenge>,
    app: tauri::AppHandle,
    state: &crate::DesktopState,
    owner: &str,
) -> Result<crate::SessionInfo, String> {
    let (active, info) =
        prepare_workspace(options, request_id, on_host_key, app, state, owner).await?;
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
    on_host_key: tauri::ipc::Channel<crate::connection_attempts::HostKeyChallenge>,
    state: State<'_, crate::DesktopState>,
    window: WebviewWindow,
) -> Result<SourceReplacement, String> {
    let app = window.app_handle().clone();
    options.validate()?;
    if options.sources.len() != 1 {
        return Err("Replace one connection source at a time".into());
    }
    let canceled = state.attempts.lock().await.claim(request_id)?;
    // Only preparation/lock acquisition is cancelable. Once committed, a late
    // cancel cannot hide the accepted result or disconnect the whole workspace.
    let prepared = crate::connection_attempts::cancellable(
        canceled.clone(),
        prepare_workspace(
            options,
            request_id,
            on_host_key,
            app,
            &state,
            window.label(),
        ),
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
        state
            .mappings
            .ensure_releasable(session_id, Some(&expected))?;
        let retired = workspace.replace_source(&expected, candidate)?;
        if replaces_files {
            transfers.close_session(session_id);
            state.directories.close_source(session_id, &expected);
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
    request_id: u64,
    on_host_key: tauri::ipc::Channel<crate::connection_attempts::HostKeyChallenge>,
    app: tauri::AppHandle,
    state: &crate::DesktopState,
    owner: &str,
) -> Result<(crate::workspace_services::WorkspaceServices, HostInfo), String> {
    let catalog = catalog(&app)?;
    let mut connections = Vec::new();
    for source in options.sources {
        if source.id == crate::builtin_ssh::ID {
            let settings = crate::builtin_ssh::options(&source)?;
            let prepared = crate::prepare_ssh(
                settings,
                request_id,
                on_host_key.clone(),
                app.clone(),
                state,
            )
            .await?;
            connections.push((source.key, prepared));
            continue;
        }
        let identity = ConnectionIdentity {
            instance: state.next_id.fetch_add(1, Ordering::Relaxed) + 1,
            generation: 1,
            adapter: source.id.clone(),
        };
        let log = app
            .state::<crate::adapter_diagnostics::AdapterDiagnostics>()
            .begin(owner, identity.clone(), request_id);
        let _preparation = PreparationObservation(log.clone());
        let catalog = catalog.clone();
        let acquired = tauri::async_runtime::spawn_blocking(move || {
            let lease = catalog
                .acquire(&source.id, &source.revision)
                .map_err(|error| error.to_string())?;
            let config = lease
                .configuration(&source.configuration)
                .map_err(|error| error.to_string())?;
            Ok::<_, String>((source.key, lease, config))
        })
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result);
        let (key, lease, config) = match acquired {
            Ok(value) => value,
            Err(error) => {
                log.preparation_failed();
                return Err(error);
            }
        };
        let process = lease
            .connect_observed(&config, Duration::from_secs(30), log)
            .await
            .map_err(|error| error.to_string())?;
        connections.push((
            key,
            crate::prepared_source::PreparedSource::adapter(identity, process)?,
        ));
    }
    crate::prepared_source::compose(connections, &options.bindings, options.name)
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
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryAdapterPackage {
    platform: String,
    path: String,
    sha256: String,
}
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryAdapterSource {
    owner: String,
    repository: String,
    reference: String,
    id: String,
    version: String,
    packages: Vec<RepositoryAdapterPackage>,
}

fn stage_repository_manifest(
    root: &std::path::Path,
    manifest: &Manifest,
    bytes: &[u8],
) -> Result<std::path::PathBuf, String> {
    let path = loop {
        let name = format!(".shellcanvas-review-{}.json", uuid::Uuid::new_v4());
        if !manifest
            .files
            .iter()
            .any(|file| file.path.eq_ignore_ascii_case(&name))
        {
            break root.join(name);
        }
    };
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, bytes))
        .map_err(|_| "Unable to stage native adapter manifest.".to_string())?;
    Ok(path)
}

#[tauri::command]
pub async fn review_repository_adapter(
    request_id: String,
    source: RepositoryAdapterSource,
    window: WebviewWindow,
    state: State<'_, AdapterJobs>,
) -> Result<AdapterReview, String> {
    let jobs = state.inner().clone();
    let owner = window.label().to_string();
    let app = window.app_handle().clone();
    let canceled = jobs.begin(&request_id, &owner)?;
    let result = async {
        let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
        let package = source.package_for_platform(&platform)?;
        let manifest_bytes = crate::repository_install::download_repository_bytes(
            source.owner.clone(),
            source.repository.clone(),
            source.reference.clone(),
            package.path.clone(),
            1024 * 1024,
            Some(&canceled),
        )
        .await?;
        if format!("{:x}", Sha256::digest(&manifest_bytes)) != package.sha256 {
            return Err(
                "Native adapter manifest integrity check failed. Review the repository again."
                    .into(),
            );
        }
        let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|_| "Native adapter manifest is invalid.".to_string())?;
        manifest.validate().map_err(|error| error.to_string())?;
        if manifest.id != source.id
            || manifest.version != source.version
            || manifest.platform != platform
        {
            return Err(
                "Native adapter identity, version, or platform does not match the app declaration."
                    .into(),
            );
        }
        let expected_digest = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&manifest)
                    .map_err(|_| "Native adapter manifest is invalid.".to_string())?
            )
        );
        let temporary = tempfile::tempdir()
            .map_err(|_| "Unable to stage native adapter download.".to_string())?;
        // The reviewed manifest is not a package asset. Keep it at an unpredictable,
        // collision-checked name and create every staged file exclusively so a declared
        // asset can never replace bytes whose identity was verified above.
        let manifest_path =
            stage_repository_manifest(temporary.path(), &manifest, &manifest_bytes)?;
        let base = package.path.rsplit_once('/').map(|(base, _)| base);
        let mut total = 0u64;
        for file in &manifest.files {
            if canceled.load(Ordering::Acquire) {
                return Err("Adapter review canceled".into());
            }
            total = total
                .checked_add(file.size)
                .ok_or("Native adapter package size overflow.")?;
            if file.size > 32 * 1024 * 1024 || total > 128 * 1024 * 1024 {
                return Err("Native adapter package exceeds the download limit.".into());
            }
            let path = match base {
                Some(base) => format!("{base}/{}", file.path),
                None => file.path.clone(),
            };
            let bytes = crate::repository_install::download_repository_bytes(
                source.owner.clone(),
                source.repository.clone(),
                source.reference.clone(),
                path,
                usize::try_from(file.size.max(1))
                    .map_err(|_| "Native adapter file is too large.")?,
                Some(&canceled),
            )
            .await?;
            let output =
                file.path
                    .split('/')
                    .fold(temporary.path().to_path_buf(), |mut path, part| {
                        path.push(part);
                        path
                    });
            std::fs::create_dir_all(
                output
                    .parent()
                    .ok_or("Invalid native adapter asset path.")?,
            )
            .map_err(|_| "Unable to stage native adapter assets.".to_string())?;
            std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(output)
                .and_then(|mut file| std::io::Write::write_all(&mut file, &bytes))
                .map_err(|_| "Unable to stage native adapter assets.".to_string())?;
        }
        let catalog = catalog(&app)?;
        let review = tauri::async_runtime::spawn_blocking(move || {
            catalog
                .review(&manifest_path, &canceled)
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())??;
        let response = AdapterReview {
            request_id: request_id.clone(),
            package: review.info(),
            replaces: review.replaces(),
        };
        if response.package.digest != expected_digest {
            return Err("Staged native adapter no longer matches its reviewed manifest.".into());
        }
        jobs.finish(&request_id, &owner, review)?;
        Ok(response)
    }
    .await;
    if result.is_err() {
        jobs.forget(&request_id, &owner);
    }
    result
}

impl RepositoryAdapterSource {
    fn package_for_platform(&self, platform: &str) -> Result<&RepositoryAdapterPackage, String> {
        let mut platforms = std::collections::HashSet::new();
        let valid = !self.packages.is_empty()
            && self.packages.len() <= 8
            && self.id.len() <= 200
            && self.version.len() <= 100
            && self.packages.iter().all(|item| {
                item.path.len() <= 240
                    && item.path.split('/').all(|part| {
                        !part.is_empty()
                            && part
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                    })
                    && item.sha256.len() == 64
                    && item
                        .sha256
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    && item.platform.len() <= 100
                    && platforms.insert(item.platform.as_str())
            });
        if !valid {
            return Err("Invalid native adapter dependency declaration.".into());
        }
        self.packages
            .iter()
            .find(|package| package.platform == platform)
            .ok_or_else(|| format!("This app's native component is not available for {platform}."))
    }
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
        || ![1, 2, 3].contains(&version)
    {
        return Err("This command is available only to the adapter probe".into());
    }
    let catalog = catalog(app)?;
    let owner = window.label().to_string();
    let jobs = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let canceled = jobs.begin(&request_id, &owner)?;
        let root = std::env::current_dir().map_err(|error| error.to_string())?;
        let path = if version == 3 {
            let report: serde_json::Value = serde_json::from_slice(
                &std::fs::read(root.join(".local/adapter-sdk-verification/latest.json"))
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
            if report["success"] != true {
                return Err("Run the standalone adapter SDK verification first".into());
            }
            std::path::PathBuf::from(
                report["package"]
                    .as_str()
                    .ok_or("Missing generated adapter package")?,
            )
        } else {
            root.join(format!(
                ".local/native-adapter-probe/packages/v{version}/adapter.json"
            ))
        };
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
    tauri::async_runtime::spawn_blocking(move || {
        // Reopening the catalog recovers crash-abandoned review staging. A
        // cleanup failure must not hide installed adapters or active connections.
        let _ = catalog.collect();
        catalog.list().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn available_connections(app: tauri::AppHandle) -> Result<Vec<AdapterInfo>, String> {
    let mut items = list_adapters(app).await?;
    items.push(crate::builtin_ssh::info());
    Ok(items)
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
    let _update_operation = crate::update_gate::operation()?;
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
pub async fn install_adapter_dependency(
    request_id: String,
    reuse: bool,
    window: WebviewWindow,
    state: State<'_, AdapterJobs>,
) -> Result<AdapterInfo, String> {
    let _update_operation = crate::update_gate::operation()?;
    let jobs = state.inner().clone();
    let owner = window.label().to_string();
    let catalog = catalog(window.app_handle())?;
    tauri::async_runtime::spawn_blocking(move || {
        let review = jobs.take(&request_id, &owner)?;
        let info = if reuse {
            catalog.satisfy(review)
        } else {
            catalog.install(review)
        }
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
    let _update_operation = crate::update_gate::operation()?;
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
    let _update_operation = crate::update_gate::operation()?;
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
    use serde_json::json;
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

    #[test]
    fn repository_asset_named_adapter_json_cannot_replace_reviewed_manifest() {
        let root = tempfile::tempdir().unwrap();
        let bytes = b"reviewed manifest";
        let manifest: Manifest = serde_json::from_value(json!({
            "schemaVersion": 1,
            "id": "dev.shellcanvas.fixture",
            "name": "Fixture",
            "version": "1.0.0",
            "description": "Fixture",
            "platform": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
            "entrypoint": "adapter.json",
            "files": [{"path":"adapter.json","size":0,"sha256":format!("{:x}", Sha256::digest([])),"executable":true}],
            "configuration": []
        })).unwrap();
        let path = stage_repository_manifest(root.path(), &manifest, bytes).unwrap();
        assert_ne!(path, root.path().join("adapter.json"));
        std::fs::write(root.path().join("adapter.json"), []).unwrap();
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }

    #[test]
    fn repository_dependency_requires_one_unique_matching_platform() {
        let package = RepositoryAdapterPackage {
            platform: "windows-x86_64".into(),
            path: "dist/adapter.json".into(),
            sha256: "a".repeat(64),
        };
        let mut source = RepositoryAdapterSource {
            owner: "example".into(),
            repository: "app".into(),
            reference: "main".into(),
            id: "dev.example.adapter".into(),
            version: "1.0.0".into(),
            packages: vec![package.clone()],
        };
        assert!(source
            .package_for_platform("linux-x86_64")
            .unwrap_err()
            .contains("not available"));
        source.packages.push(package);
        assert_eq!(
            source.package_for_platform("windows-x86_64").unwrap_err(),
            "Invalid native adapter dependency declaration."
        );
    }
}
