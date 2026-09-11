// SPDX-License-Identifier: MPL-2.0
//! Disposable, indexed metadata. SQLite bounds its page cache; file contents
//! and source handles are never retained here. No external database is needed.
//! There is deliberately no total entry or byte budget: tree size is limited by
//! the disk holding this scratch catalog, and exhaustion is reported as such.
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, ErrorCode, OptionalExtension};
use serde::{Deserialize, Serialize};
use shellcanvas_core::FileEntry;
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::SystemTime,
};

/// Bound for one catalog entry, never for a tree: the combined UTF-8 length of its
/// decoded `path`, `name`, `kind` and `revision` strings. It applies to every
/// entry (selection roots, provider pages and local files). Numeric fields, local
/// stamps, JSON encoding and the stored row are not counted; a row can be larger.
/// Deliberately independent of adapter framing; a test-only assertion checks that
/// one adapter frame cannot carry an entry above it.
pub(crate) const MAX_ENTRY_BYTES: usize = 4 * 1024 * 1024;
/// FILEDESCRIPTORW names hold fewer UTF-16 code units than this (MAX_PATH).
pub(crate) const DESCRIPTOR_PATH_UNITS: usize = 260;
pub(crate) const STORAGE_FULL: &str =
    "The disk holding the temporary transfer catalog is full. Free disk space, then try again";

/// Distinguish actual storage exhaustion from other catalog failures.
fn storage(error: impl Into<anyhow::Error>) -> anyhow::Error {
    let error = error.into();
    let full = error
        .downcast_ref::<rusqlite::Error>()
        .and_then(rusqlite::Error::sqlite_error_code)
        == Some(ErrorCode::DiskFull)
        || error
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::StorageFull);
    if full {
        error.context(STORAGE_FULL)
    } else {
        error
    }
}
/// Only Windows clipboard descriptors use this path, and they refuse names of
/// DESCRIPTOR_PATH_UNITS or more. Keep a prefix that still triggers that refusal,
/// so stored metadata cannot grow with tree depth.
fn descriptor_path(parent: Option<&Node>, name: &str) -> String {
    let mut display = match parent {
        Some(parent) => format!("{}\\{name}", parent.display),
        None => name.to_owned(),
    };
    let mut units = 0;
    if let Some(end) = display.char_indices().find_map(|(index, ch)| {
        units += ch.len_utf16();
        (units >= DESCRIPTOR_PATH_UNITS).then_some(index + ch.len_utf8())
    }) {
        display.truncate(end);
    }
    display
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(crate) struct Stamp {
    pub size: u64,
    pub modified: Option<SystemTime>,
    pub created: Option<SystemTime>,
    pub directory: bool,
    #[cfg(unix)]
    pub device: u64,
    #[cfg(unix)]
    pub inode: u64,
}
impl Stamp {
    pub fn of(metadata: &std::fs::Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            size: metadata.len(),
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
            directory: metadata.is_dir(),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Node {
    pub id: u64,
    pub parent: u64,
    pub entry: FileEntry,
    pub local: Option<Stamp>,
    pub display: String,
}
pub(crate) struct Catalog {
    db: Mutex<Connection>,
    _directory: tempfile::TempDir,
    count: AtomicU64,
    size: AtomicU64,
    portable: bool,
}
impl Catalog {
    pub fn new(portable: bool) -> Result<Self> {
        let directory = tempfile::Builder::new()
            .prefix("shellcanvas-transfer-")
            .tempdir()
            .map_err(storage)?;
        let db = Connection::open(directory.path().join("catalog.sqlite")).map_err(storage)?;
        // Scratch data: loss on process exit is fine. A bounded page cache and
        // disk-backed indexes replace unbounded vectors and hash sets.
        db.execute_batch("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; PRAGMA mmap_size=0;
            CREATE TABLE nodes(id INTEGER PRIMARY KEY, parent INTEGER NOT NULL, path TEXT NOT NULL UNIQUE, name_key TEXT NOT NULL, directory INTEGER NOT NULL, scanned INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, output TEXT, UNIQUE(parent,name_key));
            CREATE INDEX pending_directories ON nodes(scanned,directory,id);
            CREATE INDEX selection_roots ON nodes(parent,id);").map_err(storage)?;
        Ok(Self {
            db: Mutex::new(db),
            _directory: directory,
            count: AtomicU64::new(0),
            size: AtomicU64::new(0),
            portable,
        })
    }
    /// Simulate a full scratch disk: SQLite reports SQLITE_FULL beyond this size.
    #[cfg(test)]
    pub fn with_page_limit(portable: bool, pages: u32) -> Result<Self> {
        let catalog = Self::new(portable)?;
        catalog
            .db
            .lock()
            .unwrap()
            .pragma_update(None, "max_page_count", pages)?;
        Ok(catalog)
    }
    pub fn len(&self) -> u64 {
        self.count.load(Ordering::Relaxed)
    }
    pub fn size(&self) -> u64 {
        self.size.load(Ordering::Relaxed)
    }
    pub fn root_after(&self, after: u64) -> Result<Option<Node>> {
        let text: Option<String> = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("Transfer catalog lock failed"))?
            .query_row(
                "SELECT data FROM nodes WHERE parent=0 AND id>?1 ORDER BY id LIMIT 1",
                [after],
                |row| row.get(0),
            )
            .optional()?;
        text.map(|text| serde_json::from_str(&text).map_err(Into::into))
            .transpose()
    }
    pub fn has_directories(&self) -> Result<bool> {
        Ok(self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("Transfer catalog lock failed"))?
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM nodes WHERE directory=1)",
                [],
                |row| row.get(0),
            )?)
    }
    pub fn add(
        &self,
        parent: Option<&Node>,
        entries: Vec<(FileEntry, Option<Stamp>)>,
    ) -> Result<()> {
        let mut db = self
            .db
            .lock()
            .map_err(|_| anyhow::anyhow!("Transfer catalog lock failed"))?;
        let tx = db.transaction().map_err(storage)?;
        let mut count = self.len();
        let mut size = self.size();
        for (entry, local) in entries {
            if !matches!(entry.kind.as_str(), "file" | "directory") {
                bail!("Folder contains a link or special file: {}", entry.name);
            }
            if entry.path.is_empty()
                || entry.name.is_empty()
                || matches!(entry.name.as_str(), "." | "..")
                || entry.name.contains('/')
                || entry.name.chars().any(char::is_control)
            {
                bail!("Invalid folder entry: {:?}", entry.name);
            }
            if local.is_none() && entry.revision.is_empty() {
                bail!("The provider returned an unversioned entry");
            }
            if [&entry.path, &entry.name, &entry.kind, &entry.revision]
                .iter()
                .map(|text| text.len())
                .sum::<usize>()
                > MAX_ENTRY_BYTES
            {
                bail!("A transfer entry's path, name, kind and revision together exceed 4 MiB");
            }
            if self.portable {
                super::download_name(&entry.name).map_err(anyhow::Error::msg)?;
            }
            if entry.kind == "file" {
                size = size
                    .checked_add(entry.size)
                    .context("Transfer size overflow")?;
            }
            // SQLite row IDs are signed 64-bit integers.
            count = count
                .checked_add(1)
                .filter(|value| *value <= i64::MAX as u64)
                .context("Transfer catalog row identities are exhausted")?;
            let node = Node {
                id: count,
                parent: parent.map_or(0, |p| p.id),
                display: descriptor_path(parent, &entry.name),
                entry,
                local,
            };
            let key = if self.portable {
                node.entry.name.to_lowercase()
            } else {
                node.entry.name.clone()
            };
            let data = serde_json::to_string(&node)?;
            if let Err(error) = tx.execute("INSERT INTO nodes(id,parent,path,name_key,directory,data) VALUES(?1,?2,?3,?4,?5,?6)", params![node.id, node.parent, node.entry.path, key, node.entry.kind == "directory", data]) {
                // Uniqueness violations identify cycles and name aliases; storage
                // exhaustion must never be reported as a folder conflict.
                return Err(if error.sqlite_error_code() == Some(ErrorCode::ConstraintViolation) {
                    anyhow::Error::new(error).context(format!("Duplicate, cyclic, or conflicting folder entry: {}", node.entry.name))
                } else {
                    storage(error)
                });
            }
        }
        // Without a journal, a failed page cannot be rolled back reliably. Callers
        // discard the scratch catalog on any error; counts cover committed pages only.
        tx.commit().map_err(storage)?;
        self.count.store(count, Ordering::Relaxed);
        self.size.store(size, Ordering::Relaxed);
        Ok(())
    }
    pub fn get(&self, id: u64) -> Result<Node> {
        let text: String = self.db.lock().unwrap().query_row(
            "SELECT data FROM nodes WHERE id=?1",
            [id],
            |row| row.get(0),
        )?;
        Ok(serde_json::from_str(&text)?)
    }
    pub fn next_directory(&self) -> Result<Option<Node>> {
        let text: Option<String> = self
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT data FROM nodes WHERE scanned=0 AND directory=1 ORDER BY id LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        text.map(|text| serde_json::from_str(&text).map_err(Into::into))
            .transpose()
    }
    pub fn scanned(&self, id: u64) -> Result<()> {
        self.db
            .lock()
            .unwrap()
            .execute("UPDATE nodes SET scanned=1 WHERE id=?1", [id])
            .map_err(storage)?;
        Ok(())
    }
    pub fn contains_directory(&self, path: &str) -> Result<bool> {
        Ok(self.db.lock().unwrap().query_row(
            "SELECT EXISTS(SELECT 1 FROM nodes WHERE path=?1 AND directory=1)",
            [path],
            |row| row.get(0),
        )?)
    }
    pub fn output(&self, id: u64) -> Result<String> {
        Ok(self.db.lock().unwrap().query_row(
            "SELECT output FROM nodes WHERE id=?1",
            [id],
            |row| row.get(0),
        )?)
    }
    pub fn set_output(&self, id: u64, path: &str) -> Result<()> {
        self.db
            .lock()
            .unwrap()
            .execute("UPDATE nodes SET output=?1 WHERE id=?2", params![path, id])
            .map_err(storage)?;
        Ok(())
    }
    #[cfg(test)]
    pub fn scratch_path(&self) -> &std::path::Path {
        self._directory.path()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn directory(path: String, name: &str) -> FileEntry {
        FileEntry {
            path,
            name: name.into(),
            kind: "directory".into(),
            size: 0,
            modified: None,
            revision: "r".into(),
        }
    }
    #[test]
    fn descriptor_paths_stay_bounded_at_any_depth_and_still_refuse_explorer_names() {
        let catalog = Catalog::new(false).unwrap();
        let name = "\u{1f30d}".repeat(100); // 200 UTF-16 code units per level
        let mut parent: Option<Node> = None;
        for depth in 1..=1_000u64 {
            catalog
                .add(
                    parent.as_ref(),
                    vec![(directory(format!("d@{depth}"), &name), None)],
                )
                .unwrap();
            let node = catalog.get(depth).unwrap();
            let units = node.display.encode_utf16().count();
            assert!(units <= DESCRIPTOR_PATH_UNITS + 1, "depth {depth}: {units}");
            if depth > 1 {
                assert!(units >= DESCRIPTOR_PATH_UNITS, "refusal lost at {depth}");
            }
            parent = Some(node);
        }
        assert_eq!(catalog.len(), 1_000);
        assert_eq!(descriptor_path(None, "short"), "short");
    }
    #[test]
    fn individual_entries_are_bounded_without_a_tree_budget() {
        let catalog = Catalog::new(false).unwrap();
        let mut file = directory(String::new(), "n");
        file.kind = "file".into();
        file.path = "p".repeat(MAX_ENTRY_BYTES - "n".len() - "file".len() - "r".len());
        catalog.add(None, vec![(file.clone(), None)]).unwrap();
        file.path.push('p');
        file.name = "other".into();
        let error = catalog.add(None, vec![(file, None)]).unwrap_err();
        assert!(
            error.to_string().contains("together exceed 4 MiB"),
            "{error:#}"
        );
        assert_eq!(catalog.len(), 1, "a refused entry must not be counted");
    }
    /// A conforming adapter delivers each entry's four strings inside one frame,
    /// and JSON decoding never lengthens a string. Checked at compile time in test
    /// builds only, so production code keeps no dependency on adapter framing.
    #[test]
    fn adapter_frames_cannot_carry_an_entry_above_the_catalog_allowance() {
        const {
            assert!(
                shellcanvas_adapter_runtime::wire::MAX_FRAME <= MAX_ENTRY_BYTES,
                "adapter frames could deliver entries the transfer catalog refuses"
            )
        }
    }
    #[test]
    fn storage_exhaustion_is_reported_and_never_counts_the_failed_page() {
        let catalog = Catalog::with_page_limit(false, 32).unwrap();
        let mut failure = None;
        for page in 0..10_000u64 {
            let entries = (0..128)
                .map(|i| {
                    let name = format!("n{page}-{i}");
                    (directory(format!("d@{name}"), &name), None)
                })
                .collect();
            if let Err(error) = catalog.add(None, entries) {
                failure = Some((page, error));
                break;
            }
        }
        let (page, error) = failure.expect("the simulated disk never filled");
        let message = format!("{error:#}");
        assert!(message.starts_with(STORAGE_FULL), "{message}");
        assert!(!message.contains("Duplicate"), "{message}");
        assert_eq!(
            catalog.len(),
            page * 128,
            "a failed page must not be counted"
        );
        let scratch = catalog.scratch_path().to_path_buf();
        drop(catalog);
        assert!(
            !scratch.exists(),
            "scratch catalog must be removed after failure"
        );
    }
}
