// SPDX-License-Identifier: MPL-2.0
//! Disposable, indexed metadata. SQLite bounds its page cache; file contents
//! and source handles are never retained here. No external database is needed.
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use shellcanvas_core::FileEntry;
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::SystemTime,
};

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
            .tempdir()?;
        let db = Connection::open(directory.path().join("catalog.sqlite"))?;
        // Scratch data: loss on process exit is fine. A bounded page cache and
        // disk-backed indexes replace unbounded vectors and hash sets.
        db.execute_batch("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; PRAGMA mmap_size=0;
            CREATE TABLE nodes(id INTEGER PRIMARY KEY, parent INTEGER NOT NULL, path TEXT NOT NULL UNIQUE, name_key TEXT NOT NULL, directory INTEGER NOT NULL, scanned INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, output TEXT, UNIQUE(parent,name_key));
            CREATE INDEX pending_directories ON nodes(scanned,directory,id);")?;
        Ok(Self {
            db: Mutex::new(db),
            _directory: directory,
            count: AtomicU64::new(0),
            size: AtomicU64::new(0),
            portable,
        })
    }
    pub fn len(&self) -> u64 {
        self.count.load(Ordering::Relaxed)
    }
    pub fn size(&self) -> u64 {
        self.size.load(Ordering::Relaxed)
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
        let tx = db.transaction()?;
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
            if self.portable {
                super::download_name(&entry.name).map_err(anyhow::Error::msg)?;
            }
            count = count
                .checked_add(1)
                .filter(|v| *v <= i64::MAX as u64)
                .context("Transfer catalog is too large")?;
            if entry.kind == "file" {
                size = size
                    .checked_add(entry.size)
                    .context("Transfer size overflow")?;
            }
            let node = Node {
                id: count,
                parent: parent.map_or(0, |p| p.id),
                display: parent
                    .map(|p| format!("{}\\{}", p.display, entry.name))
                    .unwrap_or_else(|| entry.name.clone()),
                entry,
                local,
            };
            let key = if self.portable {
                node.entry.name.to_lowercase()
            } else {
                node.entry.name.clone()
            };
            tx.execute("INSERT INTO nodes(id,parent,path,name_key,directory,data) VALUES(?1,?2,?3,?4,?5,?6)", params![node.id, node.parent, node.entry.path, key, node.entry.kind == "directory", serde_json::to_string(&node)?])
                .with_context(|| format!("Duplicate, cyclic, or conflicting folder entry: {}", node.entry.name))?;
        }
        tx.commit()?;
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
            .execute("UPDATE nodes SET scanned=1 WHERE id=?1", [id])?;
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
            .execute("UPDATE nodes SET output=?1 WHERE id=?2", params![path, id])?;
        Ok(())
    }
    #[cfg(test)]
    pub fn scratch_path(&self) -> &std::path::Path {
        self._directory.path()
    }
}
