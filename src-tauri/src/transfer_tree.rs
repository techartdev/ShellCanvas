// SPDX-License-Identifier: MPL-2.0
//! Bounded folder plans. Only providers interpret remote paths; parent indices
//! connect entries, and only the local adapter joins local filesystem names.
use super::*;
use shellcanvas_core::FileEntry;
use std::collections::HashSet;

pub(super) const MAX_ENTRIES: usize = 1024;
const MAX_DEPTH: usize = 64;
pub(super) struct Node {
    pub parent: Option<usize>,
    pub entry: FileEntry,
    pub local: Option<(std::fs::File, Option<SystemTime>)>,
}
pub(super) struct Tree {
    pub nodes: Vec<Node>,
    pub size: u64,
}
pub(super) enum Target {
    Remote(String),
    Local(PathBuf),
}

fn entry_valid(entry: &FileEntry) -> Result<()> {
    if !matches!(entry.kind.as_str(), "file" | "directory") {
        bail!(
            "Folder transfers do not copy links or special files: {}",
            entry.name
        );
    }
    if entry.path.is_empty()
        || entry.name.is_empty()
        || matches!(entry.name.as_str(), "." | "..")
        || entry.name.contains(['/', '\\'])
        || entry.name.chars().any(char::is_control)
    {
        bail!("Invalid folder entry name: {:?}", entry.name);
    }
    Ok(())
}
impl Tree {
    fn add(&mut self, node: Node) -> Result<()> {
        entry_valid(&node.entry)?;
        if self.nodes.len() >= MAX_ENTRIES {
            bail!("Copy up to {MAX_ENTRIES} files and folders per folder tree");
        }
        if node.entry.kind == "file" {
            self.size = self
                .size
                .checked_add(node.entry.size)
                .context("Transfer size overflow")?;
        }
        self.nodes.push(node);
        Ok(())
    }
    pub fn local_names(&self) -> Result<Vec<PathBuf>> {
        let mut paths: Vec<PathBuf> = Vec::new();
        let mut names = HashSet::new();
        for node in &self.nodes {
            download_name(&node.entry.name).map_err(anyhow::Error::msg)?;
            let path = node
                .parent
                .map(|i| paths[i].join(&node.entry.name))
                .unwrap_or_else(|| PathBuf::from(&node.entry.name));
            if !names.insert(path.to_string_lossy().to_lowercase()) {
                bail!("Folder names conflict on this computer");
            }
            paths.push(path);
        }
        Ok(paths)
    }
}
pub(super) async fn remote(
    service: &Arc<dyn FileTransferService>,
    root: FileEntry,
) -> Result<Tree> {
    let mut tree = Tree {
        nodes: Vec::new(),
        size: 0,
    };
    tree.add(Node {
        parent: None,
        entry: root,
        local: None,
    })?;
    let mut seen = HashSet::from([tree.nodes[0].entry.path.clone()]);
    let mut depths = vec![0];
    let mut index = 0;
    while index < tree.nodes.len() {
        let node = &tree.nodes[index];
        if node.entry.kind == "directory" {
            if !service.supports_folders() {
                bail!("Folder transfers are unavailable on this device");
            }
            let children = service
                .transfer_children(
                    &node.entry.path,
                    &node.entry.revision,
                    MAX_ENTRIES - tree.nodes.len(),
                )
                .await?;
            let mut names = HashSet::new();
            for entry in children {
                if depths[index] >= MAX_DEPTH {
                    bail!("Folder nesting exceeds {MAX_DEPTH} levels");
                }
                if entry.revision.is_empty()
                    || !seen.insert(entry.path.clone())
                    || !names.insert(entry.name.clone())
                {
                    bail!("The provider returned duplicate or unversioned folder entries");
                }
                tree.add(Node {
                    parent: Some(index),
                    entry,
                    local: None,
                })?;
                depths.push(depths[index] + 1);
            }
        }
        index += 1;
    }
    Ok(tree)
}
fn local_metadata(path: &Path) -> Result<std::fs::Metadata> {
    let metadata = path.symlink_metadata()?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            bail!(
                "Folder transfers do not follow links, junctions, or reparse points: {}",
                path.display()
            );
        }
    }
    if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
        bail!(
            "Folder transfers do not copy links or special files: {}",
            path.display()
        );
    }
    Ok(metadata)
}
pub(super) fn local(root: PathBuf) -> Result<Tree> {
    let mut tree = Tree {
        nodes: Vec::new(),
        size: 0,
    };
    let mut pending = vec![(root, None, 0)];
    while let Some((path, parent, depth)) = pending.pop() {
        if depth > MAX_DEPTH {
            bail!("Folder nesting exceeds {MAX_DEPTH} levels");
        }
        let metadata = local_metadata(&path)?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .context("Invalid local filename")?
            .to_owned();
        let index = tree.nodes.len();
        let local = if metadata.is_file() {
            let (file, size, modified) = source(&path)?;
            if size != metadata.len() || modified != metadata.modified().ok() {
                bail!("Local file changed while preparing folder");
            }
            Some((file, modified))
        } else {
            None
        };
        tree.add(Node {
            parent,
            entry: FileEntry {
                name,
                path: path.to_string_lossy().into_owned(),
                kind: if metadata.is_dir() {
                    "directory"
                } else {
                    "file"
                }
                .into(),
                size: if metadata.is_dir() { 0 } else { metadata.len() },
                modified: None,
                revision: String::new(),
            },
            local,
        })?;
        if metadata.is_dir() {
            for child in std::fs::read_dir(&path)? {
                if pending.len() + tree.nodes.len() >= MAX_ENTRIES {
                    bail!("Copy up to {MAX_ENTRIES} files and folders per folder tree");
                }
                pending.push((child?.path(), Some(index), depth + 1));
            }
            if local_metadata(&path)?.modified().ok() != metadata.modified().ok() {
                bail!("Local folder changed during preparation");
            }
        }
    }
    Ok(tree)
}

pub(super) async fn execute_tree(
    tree: Tree,
    target: Target,
    service: Arc<dyn FileTransferService>,
    cancel: &watch::Receiver<bool>,
    progress: &mut (dyn FnMut(Progress) + Send),
) -> Result<String> {
    let total = tree.size;
    let local_paths = if let Target::Local(destination) = &target {
        let relative = tree.local_names()?;
        Some(
            relative
                .into_iter()
                .map(|path| destination.parent().unwrap().join(path))
                .collect::<Vec<_>>(),
        )
    } else {
        None
    };
    if let Target::Remote(parent) = &target {
        if !service.supports_folders() {
            bail!("Folder transfers are unavailable on this device");
        }
        if tree
            .nodes
            .iter()
            .any(|node| node.entry.kind == "directory" && node.entry.path == *parent)
        {
            bail!("A folder cannot be copied into itself or a descendant");
        }
    }
    // Refresh every source directory before the first destination mutation.
    if tree.nodes[0].local.is_none() && !tree.nodes[0].entry.revision.is_empty() {
        for node in &tree.nodes {
            checkpoint(cancel)?;
            if node.entry.kind == "directory" {
                service
                    .transfer_children(&node.entry.path, &node.entry.revision, MAX_ENTRIES)
                    .await?;
            }
        }
    }
    let mut paths: Vec<String> = Vec::new();
    let mut completed = 0;
    let work: Result<String> = async {
        for (index, node) in tree.nodes.into_iter().enumerate() {
            checkpoint(cancel)?;
            let parent = match &target {
                Target::Remote(parent) => node
                    .parent
                    .map(|i| paths[i].clone())
                    .unwrap_or_else(|| parent.clone()),
                Target::Local(_) => String::new(),
            };
            let path = if node.entry.kind == "directory" {
                if let Some(local) = &local_paths {
                    std::fs::create_dir(&local[index])?;
                    local[index].to_string_lossy().into_owned()
                } else {
                    service
                        .transfer_mkdir(&parent, &node.entry.name)
                        .await?
                        .path
                }
            } else {
                let job = if let Some(local) = &local_paths {
                    Job::Download {
                        destination: local[index].clone(),
                        path: node.entry.path,
                        revision: node.entry.revision,
                    }
                } else if let Some((file, modified)) = node.local {
                    Job::Upload {
                        file,
                        parent,
                        name: node.entry.name,
                        size: node.entry.size,
                        modified,
                    }
                } else {
                    Job::Copy {
                        path: node.entry.path,
                        revision: node.entry.revision,
                        parent,
                        name: node.entry.name,
                    }
                };
                let path = Box::pin(super::execute(job, service.clone(), cancel, &mut |event| {
                    progress(Progress {
                        bytes: completed + event.bytes,
                        total,
                        phase: "running",
                    })
                }))
                .await?;
                completed += node.entry.size;
                path
            };
            paths.push(path);
        }
        progress(Progress {
            bytes: completed,
            total,
            phase: "finishing",
        });
        Ok(paths[0].clone())
    }
    .await;
    work.map_err(|error| match paths.first() {
        Some(root) => anyhow::anyhow!(
            "{error:#}. Folder transfer is incomplete; completed items remain at {root}"
        ),
        None => error,
    })
}
