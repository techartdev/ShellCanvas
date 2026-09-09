// SPDX-License-Identifier: MPL-2.0
//! Iterative paged discovery into a disk-backed catalog. One directory cursor
//! and one active file stream are sufficient regardless of tree size/depth.
use super::catalog::{Catalog, Node, Stamp};
use super::*;
use shellcanvas_core::{FileEntry, TRANSFER_DIRECTORY_PAGE};

pub(super) struct Tree {
    pub root: Node,
}
pub(super) enum Target {
    Remote(String),
    Local(PathBuf),
}

pub(super) async fn remote(
    service: &Arc<dyn FileTransferService>,
    root: FileEntry,
) -> Result<Tree> {
    if root.kind == "directory" && !service.supports_folders() {
        bail!("Folder transfers are unavailable on this device");
    }
    if !matches!(root.kind.as_str(), "file" | "directory") {
        bail!("Folder transfers do not copy links or special files");
    }
    Ok(Tree {
        root: Node {
            id: 0,
            parent: 0,
            display: root.name.clone(),
            entry: root,
            local: None,
        },
    })
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
fn local_entry(path: &Path) -> Result<(FileEntry, Option<Stamp>)> {
    let metadata = local_metadata(path)?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .context("Invalid local filename")?
        .to_owned();
    Ok((
        FileEntry {
            name,
            path: path.to_str().context("Invalid local path")?.into(),
            kind: if metadata.is_dir() {
                "directory"
            } else {
                "file"
            }
            .into(),
            size: if metadata.is_file() {
                metadata.len()
            } else {
                0
            },
            revision: String::new(),
            modified: None,
        },
        Some(Stamp::of(&metadata)),
    ))
}
pub(super) fn local(root: PathBuf) -> Result<Tree> {
    local_metadata(&root)?;
    let root = root.canonicalize()?;
    let (entry, local) = local_entry(&root)?;
    Ok(Tree {
        root: Node {
            id: 0,
            parent: 0,
            display: entry.name.clone(),
            entry,
            local,
        },
    })
}
fn check_local(node: &Node) -> Result<()> {
    let path = Path::new(&node.entry.path);
    if path.canonicalize()? != path || Some(Stamp::of(&local_metadata(path)?)) != node.local {
        bail!(
            "Local source changed since discovery: {}. Copy it again.",
            node.entry.name
        );
    }
    Ok(())
}
fn open_local(node: &Node) -> Result<std::fs::File> {
    check_local(node)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(&node.entry.path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || Some(Stamp::of(&metadata)) != node.local {
        bail!("Local source changed while opening it");
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            bail!("Local source became a reparse point");
        }
    }
    Ok(file)
}

pub(super) async fn scan(
    tree: Tree,
    service: Arc<dyn FileTransferService>,
    portable: bool,
    cancel: &watch::Receiver<bool>,
    progress: &mut (dyn FnMut(Progress) + Send),
) -> Result<Arc<Catalog>> {
    checkpoint(cancel)?;
    let catalog = Arc::new(Catalog::new(portable)?);
    catalog.add(None, vec![(tree.root.entry, tree.root.local)])?;
    scan_catalog(catalog, service, cancel, progress).await
}

/// Root selections share one database and one directory cursor, regardless of root count.
pub(super) async fn scan_catalog(
    catalog: Arc<Catalog>,
    service: Arc<dyn FileTransferService>,
    cancel: &watch::Receiver<bool>,
    progress: &mut (dyn FnMut(Progress) + Send),
) -> Result<Arc<Catalog>> {
    checkpoint(cancel)?;
    progress(Progress {
        items: Some(catalog.len()),
        bytes: 0,
        total: catalog.size(),
        phase: "preparing",
    });
    while let Some(node) = catalog.next_directory()? {
        checkpoint(cancel)?;
        if node.local.is_some() {
            let selected = node.clone();
            let mut read = tokio::task::spawn_blocking(move || -> Result<_> {
                check_local(&selected)?;
                Ok(std::fs::read_dir(&selected.entry.path)?)
            })
            .await??;
            loop {
                let canceled = cancel.clone();
                let (returned, entries, eof) = tokio::task::spawn_blocking(move || -> Result<_> {
                    let mut entries = Vec::with_capacity(TRANSFER_DIRECTORY_PAGE);
                    let mut eof = false;
                    for _ in 0..TRANSFER_DIRECTORY_PAGE {
                        checkpoint(&canceled)?;
                        match read.next() {
                            Some(child) => entries.push(local_entry(&child?.path())?),
                            None => {
                                eof = true;
                                break;
                            }
                        }
                    }
                    Ok((read, entries, eof))
                })
                .await??;
                read = returned;
                catalog.add(Some(&node), entries)?;
                progress(Progress {
                    items: Some(catalog.len()),
                    bytes: 0,
                    total: catalog.size(),
                    phase: "preparing",
                });
                if eof {
                    break;
                }
            }
            check_local(&node)?;
        } else {
            let mut cursor = service
                .clone()
                .transfer_directory(&node.entry.path, &node.entry.revision)
                .await?;
            let work: Result<()> = async {
                loop {
                    checkpoint(cancel)?;

                    let entries = tokio::select! {
                        entries = cursor.next() => entries?,
                        _ = wait_for_cancel(cancel.clone()) => { checkpoint(cancel)?; bail!("Transfer canceled"); }
                    };
                    if entries.is_empty() { break; }
                    if entries.len() > TRANSFER_DIRECTORY_PAGE { bail!("Provider exceeded the directory page budget"); }
                    catalog.add(Some(&node), entries.into_iter().map(|entry| (entry,None)).collect())?;
                    progress(Progress { items: Some(catalog.len()), bytes: 0, total: catalog.size(), phase: "preparing" });
                    tokio::task::yield_now().await;
                }
                cursor.finish().await
            }.await;
            if let Err(error) = work {
                let cleanup =
                    tokio::time::timeout(std::time::Duration::from_secs(3), cursor.abort())
                        .await
                        .context("Directory cleanup timed out")
                        .and_then(|result| result);
                return Err(cleanup_error(error, cleanup));
            }
        }
        catalog.scanned(node.id)?;
        tokio::task::yield_now().await;
    }
    checkpoint(cancel)?;
    Ok(catalog)
}

pub(super) async fn execute_tree(
    tree: Tree,
    target: Target,
    service: Arc<dyn FileTransferService>,
    cancel: &watch::Receiver<bool>,
    progress: &mut (dyn FnMut(Progress) + Send),
) -> Result<String> {
    let catalog = scan(
        tree,
        service.clone(),
        matches!(target, Target::Local(_)),
        cancel,
        progress,
    )
    .await?;
    execute_catalog(catalog, target, service, cancel, progress, None).await
}

pub(super) async fn execute_selection(
    catalog: Arc<Catalog>,
    parent: String,
    service: Arc<dyn FileTransferService>,
    cancel: &watch::Receiver<bool>,
    progress: &mut (dyn FnMut(Progress) + Send),
) -> Result<String> {
    if catalog.has_directories()? && !service.supports_folders() {
        bail!("Folder transfers are unavailable on this device");
    }
    let destination = (catalog.len() > 1).then(|| parent.clone());
    let catalog = scan_catalog(catalog, service.clone(), cancel, progress).await?;
    execute_catalog(
        catalog,
        Target::Remote(parent),
        service,
        cancel,
        progress,
        destination,
    )
    .await
}

async fn execute_catalog(
    catalog: Arc<Catalog>,
    target: Target,
    service: Arc<dyn FileTransferService>,
    cancel: &watch::Receiver<bool>,
    progress: &mut (dyn FnMut(Progress) + Send),
    selection_destination: Option<String>,
) -> Result<String> {
    if let Target::Remote(parent) = &target {
        if catalog.has_directories()? && !service.supports_folders() {
            bail!("Folder transfers are unavailable on this device");
        }
        if catalog.contains_directory(parent)? {
            bail!("A folder cannot be copied into itself or a descendant");
        }
    }
    let mut root = None;
    let mut completed = 0;
    let total = catalog.size();
    let work: Result<String> = async {
        for id in 1..=catalog.len() {
            checkpoint(cancel)?;
            let node = catalog.get(id)?;
            let parent = if node.parent == 0 {
                match &target {
                    Target::Remote(parent) => parent.clone(),
                    Target::Local(_) => String::new(),
                }
            } else {
                catalog.output(node.parent)?
            };
            let destination = match &target {
                Target::Local(destination) if node.parent == 0 => Some(destination.clone()),
                Target::Local(_) => {
                    let parent_path = Path::new(&parent);
                    if !local_metadata(parent_path)?.is_dir()
                        || parent_path.canonicalize()? != parent_path
                    {
                        bail!("Local destination folder changed");
                    }
                    Some(parent_path.join(&node.entry.name))
                }
                Target::Remote(_) => None,
            };
            let path = if node.entry.kind == "directory" {
                if let Some(destination) = destination {
                    std::fs::create_dir(&destination)?;
                    destination.canonicalize()?.to_string_lossy().into_owned()
                } else {
                    service
                        .transfer_mkdir(&parent, &node.entry.name)
                        .await?
                        .path
                }
            } else {
                let job = if let Some(destination) = destination {
                    Job::Download {
                        destination,
                        path: node.entry.path.clone(),
                        revision: node.entry.revision.clone(),
                    }
                } else if let Some(stamp) = &node.local {
                    let selected = node.clone();
                    let file = tokio::task::spawn_blocking(move || open_local(&selected)).await??;
                    Job::Upload {
                        file,
                        parent,
                        name: node.entry.name.clone(),
                        size: stamp.size,
                        modified: stamp.modified,
                    }
                } else {
                    Job::Copy {
                        path: node.entry.path.clone(),
                        revision: node.entry.revision.clone(),
                        parent,
                        name: node.entry.name.clone(),
                    }
                };
                let path = Box::pin(super::execute(job, service.clone(), cancel, &mut |event| {
                    progress(Progress {
                        items: None,
                        bytes: completed + event.bytes,
                        total,
                        phase: "running",
                    })
                }))
                .await?;
                completed += node.entry.size;
                path
            };
            if root.is_none() {
                root = Some(path.clone());
            }
            catalog.set_output(id, &path)?;
            progress(Progress {
                items: Some(id),
                bytes: completed,
                total,
                phase: "running",
            });
            tokio::task::yield_now().await;
        }
        progress(Progress {
            items: None,
            bytes: completed,
            total,
            phase: "finishing",
        });
        selection_destination
            .clone()
            .or_else(|| root.clone())
            .context("Transfer selection has no root")
    }
    .await;
    work.map_err(|error| match root {
        Some(root) => anyhow::anyhow!(
            "{error:#}. Transfer is incomplete; completed items remain at {}",
            selection_destination.as_ref().unwrap_or(&root)
        ),
        None => error,
    })
}

#[cfg(test)]
#[path = "transfer_scan_tests.rs"]
mod scan_tests;
