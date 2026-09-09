// SPDX-License-Identifier: MPL-2.0
//! Reviewed, version-pinned native packages. Never executes code while reviewing/installing.
use crate::catalog_staging::Staging;
use crate::Launch;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

const MANIFEST_LIMIT: u64 = 1024 * 1024;
use shellcanvas_adapter_sdk::package::relative;
pub use shellcanvas_adapter_sdk::package::{ConfigField, FieldKind, Manifest, PackageFile};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdapterInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub platform: String,
    pub entrypoint: String,
    pub configuration: Vec<ConfigField>,
    pub generation: String,
    pub revision: String,
    pub enabled: bool,
    pub file_count: usize,
    pub bytes: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    manifest: Manifest,
    generation: String,
    revision: String,
    enabled: bool,
}
impl Record {
    fn info(&self) -> AdapterInfo {
        AdapterInfo {
            id: self.manifest.id.clone(),
            name: self.manifest.name.clone(),
            version: self.manifest.version.clone(),
            description: self.manifest.description.clone(),
            platform: self.manifest.platform.clone(),
            entrypoint: self.manifest.entrypoint.clone(),
            configuration: self.manifest.configuration.clone(),
            generation: self.generation.clone(),
            revision: self.revision.clone(),
            enabled: self.enabled,
            file_count: self.manifest.files.len(),
            bytes: self.manifest.files.iter().map(|file| file.size).sum(),
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Store {
    version: u32,
    records: Vec<Record>,
}
pub struct Review {
    owner: PathBuf,
    staged: Staging,
    record: Record,
    expected: Option<String>,
}
impl Review {
    pub fn info(&self) -> AdapterInfo {
        self.record.info()
    }
    pub fn replaces(&self) -> bool {
        self.expected.is_some()
    }
}
/// Keeping this object alive pins package assets across processes, updates and removal.
pub struct PackageLease {
    _lock: File,
    directory: PathBuf,
    manifest: Manifest,
    pub info: AdapterInfo,
}
impl PackageLease {
    /// Pins installed assets in the process supervisor, including canceled initialization.
    pub async fn connect(
        self,
        configuration: &Value,
        deadline: std::time::Duration,
    ) -> Result<crate::AdapterProcess> {
        self.connect_observed(configuration, deadline, crate::Diagnostics::default())
            .await
    }
    pub async fn connect_observed(
        self,
        configuration: &Value,
        deadline: std::time::Duration,
        diagnostics: crate::Diagnostics,
    ) -> Result<crate::AdapterProcess> {
        let configuration = match self.configuration(configuration) {
            Ok(configuration) => configuration,
            Err(error) => {
                diagnostics.preparation_failed();
                return Err(error);
            }
        };
        let launch = self.launch();
        Ok(crate::AdapterProcess::launch_owned_observed(
            launch,
            configuration,
            deadline,
            Some(std::sync::Arc::new(self)),
            diagnostics,
        )
        .await?)
    }
    pub fn launch(&self) -> Launch {
        Launch {
            executable: self.directory.join(&self.manifest.entrypoint),
            arguments: self.manifest.arguments.clone(),
            directory: self.directory.clone(),
        }
    }
    pub fn configuration(&self, value: &Value) -> Result<Value> {
        self.manifest.validate_configuration(value)
    }
}
#[derive(Clone)]
pub struct Catalog {
    root: PathBuf,
}
impl Catalog {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
    fn locked<T>(&self, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        fs::create_dir_all(self.root.join("objects"))?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.root.join("catalog.lock"))?;
        lock.lock()?;
        operation()
    }
    fn load(&self) -> Result<Store> {
        let path = self.root.join("catalog.json");
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Store {
                    version: 1,
                    records: vec![],
                })
            }
            Err(error) => return Err(error.into()),
        };
        let store: Store = serde_json::from_slice(&bytes)
            .context("Adapter catalog is invalid; it was not changed")?;
        if store.version != 1 {
            bail!("Unsupported adapter catalog version; it was not changed");
        }
        let mut ids = HashSet::new();
        for record in &store.records {
            record.manifest.validate()?;
            if !ids.insert(&record.manifest.id)
                || uuid::Uuid::parse_str(&record.generation).is_err()
                || uuid::Uuid::parse_str(&record.revision).is_err()
            {
                bail!("Invalid adapter catalog identities; it was not changed");
            }
        }
        Ok(store)
    }
    fn save(&self, store: &Store) -> Result<()> {
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root)?;
        serde_json::to_writer_pretty(&mut temporary, store)?;
        temporary.as_file().sync_all()?;
        temporary.persist(self.root.join("catalog.json"))?;
        Ok(())
    }
    pub fn list(&self) -> Result<Vec<AdapterInfo>> {
        self.locked(|| Ok(self.load()?.records.iter().map(Record::info).collect()))
    }
    /// Copies and hashes declared files incrementally into a review-owned temporary directory.
    /// The original source can be moved/edited after review without changing reviewed bytes.
    pub fn review(&self, manifest_path: &Path, canceled: &AtomicBool) -> Result<Review> {
        let manifest_path = manifest_path.canonicalize()?;
        let source = manifest_path
            .parent()
            .context("Adapter manifest has no parent directory")?;
        let manifest: Manifest = read_manifest(&manifest_path)?;
        manifest.validate()?;
        if manifest.platform != format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH) {
            bail!("This adapter package is for a different platform");
        }
        let (expected, enabled, staged) = self.locked(|| {
            let store = self.load()?;
            let (expected, enabled) = store
                .records
                .iter()
                .find(|record| record.manifest.id == manifest.id)
                .map(|record| (Some(record.revision.clone()), record.enabled))
                .unwrap_or((None, true));
            // Publish the staging directory and its lease under the same lock
            // used by recovery. Copying then proceeds outside the catalog lock.
            Ok((expected, enabled, Staging::new(&self.root)?))
        })?;
        let payload = staged.path().join("payload");
        fs::create_dir(&payload)?;
        for entry in &manifest.files {
            check_canceled(canceled)?;
            let input = source_file(source, &entry.path)?;
            let output = payload.join(&entry.path);
            fs::create_dir_all(output.parent().context("Invalid asset parent")?)?;
            let mut output_file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&output)?;
            copy_verified(&input, &mut output_file, entry, canceled)?;
            output_file.sync_all()?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(
                    &output,
                    fs::Permissions::from_mode(if entry.executable { 0o700 } else { 0o600 }),
                )?;
            }
        }
        check_canceled(canceled)?;
        let record = Record {
            manifest,
            generation: uuid::Uuid::new_v4().to_string(),
            revision: uuid::Uuid::new_v4().to_string(),
            enabled,
        };
        let mut metadata = File::create(staged.path().join("manifest.json"))?;
        serde_json::to_writer_pretty(&mut metadata, &record.manifest)?;
        metadata.sync_all()?;
        Ok(Review {
            owner: self.root.canonicalize()?,
            staged,
            record,
            expected,
        })
    }
    /// A review is consumed once. Stale catalog decisions cannot overwrite another app process.
    pub fn install(&self, mut review: Review) -> Result<AdapterInfo> {
        self.locked(|| {
            if review.owner != self.root.canonicalize()? {
                bail!("This review belongs to another adapter catalog");
            }
            let mut store = self.load()?;
            let index = store
                .records
                .iter()
                .position(|record| record.manifest.id == review.record.manifest.id);
            let actual = index.map(|i| store.records[i].revision.clone());
            if actual != review.expected {
                bail!("This adapter changed while being reviewed. Review the package again");
            }
            let destination = self.root.join("objects").join(&review.record.generation);
            if destination.exists() {
                bail!("Adapter generation already exists");
            }
            review.staged.release_for_install();
            fs::rename(review.staged.path(), &destination)?;
            let info = review.record.info();
            if let Some(index) = index {
                store.records[index] = review.record;
            } else {
                store.records.push(review.record);
            }
            self.save(&store)?;
            Ok(info)
        })
    }
    pub fn set_enabled(&self, id: &str, revision: &str, enabled: bool) -> Result<AdapterInfo> {
        self.locked(|| {
            let mut store = self.load()?;
            let record = store
                .records
                .iter_mut()
                .find(|record| record.manifest.id == id && record.revision == revision)
                .context("Adapter changed or was removed; refresh before changing it")?;
            record.enabled = enabled;
            record.revision = uuid::Uuid::new_v4().to_string();
            let info = record.info();
            self.save(&store)?;
            Ok(info)
        })
    }
    pub fn remove(&self, id: &str, revision: &str) -> Result<()> {
        self.locked(|| {
            let mut store = self.load()?;
            let index = store
                .records
                .iter()
                .position(|record| record.manifest.id == id && record.revision == revision)
                .context("Adapter changed or was removed; refresh before removing it")?;
            store.records.remove(index);
            self.save(&store)
        })
    }
    pub fn acquire(&self, id: &str, revision: &str) -> Result<PackageLease> {
        let lease = self.locked(|| {
            let store = self.load()?;
            let record = store
                .records
                .iter()
                .find(|record| record.manifest.id == id && record.revision == revision)
                .context("Adapter changed or was removed; refresh before connecting")?;
            if !record.enabled {
                bail!("This adapter is disabled");
            }
            let directory = self.root.join("objects").join(&record.generation);
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .open(directory.join("lease.lock"))?;
            lock.lock_shared()?;
            Ok(PackageLease {
                _lock: lock,
                directory: directory.join("payload"),
                manifest: record.manifest.clone(),
                info: record.info(),
            })
        })?;
        // Content checks occur under the shared lease, outside the catalog mutation lock.
        // They catch changed installed files; this is not protection against a hostile OS account.
        for file in &lease.manifest.files {
            let input = source_file(&lease.directory, &file.path)?;
            copy_verified(&input, &mut std::io::sink(), file, &AtomicBool::new(false))?;
        }
        Ok(lease)
    }
    /// Collect unreferenced generations and abandoned versioned reviews, only
    /// when no OS lease is held in any app process. Returns directories removed.
    pub fn collect(&self) -> Result<usize> {
        self.locked(|| {
            let retained: HashSet<_> = self
                .load()?
                .records
                .into_iter()
                .map(|record| record.generation)
                .collect();
            let objects = self.root.join("objects").canonicalize()?;
            let mut removed = 0;
            for item in fs::read_dir(&objects)? {
                let item = item?;
                let name = item.file_name().to_string_lossy().to_string();
                if retained.contains(&name)
                    || uuid::Uuid::parse_str(&name).is_err()
                    || item.file_type()?.is_symlink()
                    || !item.file_type()?.is_dir()
                {
                    continue;
                }
                let target = item.path().canonicalize()?;
                if target.parent() != Some(objects.as_path()) {
                    continue;
                }
                let Ok(lock) = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(target.join("lease.lock"))
                else {
                    continue;
                };
                if lock.try_lock().is_err() {
                    continue;
                }
                drop(lock); // The catalog lock prevents a new acquire while removal runs.
                if fs::remove_dir_all(&target).is_ok() {
                    removed += 1;
                }
            }
            Ok(removed + crate::catalog_staging::collect(&self.root)?)
        })
    }
}
fn read_manifest(path: &Path) -> Result<Manifest> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MANIFEST_LIMIT + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MANIFEST_LIMIT {
        bail!("Adapter manifest exceeds 1 MiB");
    }
    serde_json::from_slice(&bytes).context("Invalid adapter manifest")
}
fn check_canceled(canceled: &AtomicBool) -> Result<()> {
    if canceled.load(Ordering::Acquire) {
        bail!("Adapter review canceled");
    }
    Ok(())
}
fn copy_verified(
    path: &Path,
    output: &mut impl Write,
    entry: &PackageFile,
    canceled: &AtomicBool,
) -> Result<()> {
    let mut input = File::open(path)?;
    if !input.metadata()?.is_file() || input.metadata()?.len() != entry.size {
        bail!("Adapter file size changed: {}", entry.path);
    }
    let mut digest = Sha256::new();
    let mut copied = 0u64;
    let mut chunk = [0; 64 * 1024];
    loop {
        check_canceled(canceled)?;
        let length = input.read(&mut chunk)?;
        if length == 0 {
            break;
        }
        copied = copied
            .checked_add(length as u64)
            .context("Adapter file size overflow")?;
        if copied > entry.size {
            bail!("Adapter file grew during review: {}", entry.path);
        }
        digest.update(&chunk[..length]);
        output.write_all(&chunk[..length])?;
    }
    if copied != entry.size || format!("{:x}", digest.finalize()) != entry.sha256 {
        bail!("Adapter file does not match its manifest: {}", entry.path);
    }
    Ok(())
}
fn source_file(root: &Path, path: &str) -> Result<PathBuf> {
    relative(path)?;
    let mut input = root.to_path_buf();
    for part in path.split('/') {
        input.push(part);
        if fs::symlink_metadata(&input)?.file_type().is_symlink() {
            bail!("Adapter assets cannot be symbolic links");
        }
    }
    let canonical = input.canonicalize()?;
    if !canonical.starts_with(root.canonicalize()?) || !fs::metadata(&canonical)?.is_file() {
        bail!("Adapter asset escapes its package directory");
    }
    Ok(canonical)
}
