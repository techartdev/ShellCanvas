// SPDX-License-Identifier: MPL-2.0
use super::*;
use async_trait::async_trait;
use shellcanvas_core::{FileEntry, FileLocation};
use std::collections::HashSet;
use std::sync::Mutex;

fn entry(path: &str, name: &str, directory: bool, size: u64) -> FileEntry {
    FileEntry {
        path: path.into(),
        name: name.into(),
        kind: if directory { "directory" } else { "file" }.into(),
        size,
        revision: "v1".into(),
        modified: None,
    }
}
struct Folders {
    data: Arc<super::tests::Memory>,
    created: Mutex<HashSet<String>>,
    bad_child: Option<FileEntry>,
}
struct Page(Vec<FileEntry>);
#[async_trait]
impl shellcanvas_core::TransferDirectory for Page {
    async fn next(&mut self) -> Result<Vec<FileEntry>> {
        let count = self.0.len().min(shellcanvas_core::TRANSFER_DIRECTORY_PAGE);
        Ok(self.0.drain(..count).collect())
    }
    async fn finish(&mut self) -> Result<()> {
        Ok(())
    }
    async fn abort(&mut self) -> Result<()> {
        Ok(())
    }
}
async fn scanned(
    service: Arc<dyn FileTransferService>,
    root: FileEntry,
    portable: bool,
) -> Result<Arc<catalog::Catalog>> {
    let plan = tree::remote(&service, root).await?;
    let (_stop, cancel) = watch::channel(false);
    tree::scan(plan, service, portable, &cancel, &mut |_| {}).await
}
#[async_trait]
impl FileTransferService for Folders {
    fn supports_folders(&self) -> bool {
        true
    }
    async fn transfer_directory(
        self: Arc<Self>,
        path: &str,
        _: &str,
    ) -> Result<Box<dyn shellcanvas_core::TransferDirectory>> {
        Ok(Box::new(Page(if path == "root@opaque" {
            match &self.bad_child {
                Some(child) => vec![child.clone()],
                None => vec![
                    entry("empty@opaque", "Empty", true, 0),
                    entry(
                        "file@opaque",
                        "binary.bin",
                        false,
                        self.data.data.len() as u64,
                    ),
                ],
            }
        } else {
            vec![]
        })))
    }
    async fn transfer_mkdir(&self, parent: &str, name: &str) -> Result<FileLocation> {
        // Deliberately non-path identifiers expose accidental path construction.
        let path = format!("{name}@child-of({parent})");
        if !self.created.lock().unwrap().insert(path.clone()) {
            bail!("already exists");
        }
        Ok(FileLocation {
            path,
            name: name.into(),
            parent: Some(parent.into()),
        })
    }
    async fn download(
        self: Arc<Self>,
        path: &str,
        revision: &str,
    ) -> Result<Box<dyn shellcanvas_core::TransferReader>> {
        self.data.clone().download(path, revision).await
    }
    async fn upload(
        self: Arc<Self>,
        parent: &str,
        name: &str,
        size: u64,
    ) -> Result<Box<dyn shellcanvas_core::TransferWriter>> {
        self.data.clone().upload(parent, name, size).await
    }
}
fn provider(bad_child: Option<FileEntry>) -> Arc<dyn FileTransferService> {
    Arc::new(Folders {
        data: super::tests::Memory::new(false),
        created: Mutex::new(HashSet::new()),
        bad_child,
    })
}
fn download_plan(plan: tree::Tree, folder: &Path) -> Job {
    let catalog = Arc::new(catalog::Catalog::new(true).unwrap());
    catalog
        .add(None, vec![(plan.root.entry, plan.root.local)])
        .unwrap();
    Job::DownloadSelection {
        catalog,
        folder: folder.canonicalize().unwrap(),
    }
}
#[tokio::test]
async fn selection_catalog_keeps_distinct_roots_and_nested_descriptor_paths() {
    let service = provider(None);
    let catalog = Arc::new(catalog::Catalog::new(true).unwrap());
    for index in 0..128 {
        catalog
            .add(
                None,
                vec![(
                    entry(
                        &format!("single@{index}"),
                        &format!("single-{index}.bin"),
                        false,
                        1,
                    ),
                    None,
                )],
            )
            .unwrap();
    }
    catalog
        .add(None, vec![(entry("root@opaque", "Root", true, 0), None)])
        .unwrap();
    let (_stop, cancel) = watch::channel(false);
    let catalog = tree::scan_catalog(catalog, service.clone(), &cancel, &mut |_| {})
        .await
        .unwrap();
    assert_eq!(catalog.len(), 131);
    assert_eq!(catalog.get(1).unwrap().display, "single-0.bin");
    assert_eq!(catalog.get(129).unwrap().display, "Root");
    assert_eq!(catalog.get(130).unwrap().display, "Root\\Empty");
    assert_eq!(catalog.get(131).unwrap().display, "Root\\binary.bin");
    #[cfg(windows)]
    {
        let sources = crate::clipboard_stream::Sources::catalogs(
            vec![catalog.clone()],
            service,
            tokio::runtime::Handle::current(),
        );
        assert_eq!(sources.len(), 131);
        assert_eq!(sources.get(130).unwrap().display_path, "Root\\binary.bin");
        assert_eq!(sources.get(130).unwrap().entry.path, "file@opaque");
    }
    // The same Windows destination name cannot be supplied by another root.
    assert!(catalog
        .add(None, vec![(entry("another@root", "ROOT", true, 0), None)])
        .is_err());
}
#[tokio::test]
async fn local_folder_plan_keeps_metadata_and_empty_directories_without_open_files() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("Folder");
    std::fs::create_dir_all(root.join("Nested/Empty")).unwrap();
    std::fs::write(root.join("Nested/data.bin"), b"test bytes").unwrap();
    let plan = tree::local(root).unwrap();
    let (_stop, cancel) = watch::channel(false);
    let catalog = tree::scan(plan, provider(None), true, &cancel, &mut |_| {})
        .await
        .unwrap();
    assert_eq!(catalog.len(), 4);
    assert_eq!(catalog.size(), 10);
    let paths: Vec<_> = (1..=catalog.len())
        .map(|id| catalog.get(id).unwrap().display)
        .collect();
    assert!(paths.contains(&"Folder\\Nested\\Empty".to_string()));
    let scratch = catalog.scratch_path().to_path_buf();
    drop(catalog);
    assert!(!scratch.exists());
}
#[tokio::test]
async fn remote_folder_plan_rejects_cycles_links_escapes_and_local_case_aliases() {
    for child in [
        entry("root@opaque", "loop", true, 0),
        entry("bad", "../escape", false, 1),
        FileEntry {
            kind: "symlink".into(),
            ..entry("link", "link", false, 1)
        },
    ] {
        assert!(scanned(
            provider(Some(child)),
            entry("root@opaque", "Root", true, 0),
            true
        )
        .await
        .is_err());
    }
    let catalog = scanned(provider(None), entry("root@opaque", "Root", true, 0), true)
        .await
        .unwrap();
    let root = catalog.get(1).unwrap();
    assert!(catalog
        .add(
            Some(&root),
            vec![(entry("another", "BINARY.BIN", false, 1), None)]
        )
        .is_err());
}
#[tokio::test]
async fn folder_download_preserves_empty_directories_refuses_merging_and_reports_partial_cancel() {
    for cancel_early in [false, true] {
        let service = provider(None);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Root");
        let plan = tree::remote(&service, entry("root@opaque", "Root", true, 0))
            .await
            .unwrap();
        let (stop, cancel) = watch::channel(false);
        let mut last = 0;
        let result = execute(
            download_plan(plan, temp.path()),
            service.clone(),
            &cancel,
            &mut |event| {
                assert!(event.bytes >= last);
                last = event.bytes;
                if cancel_early && event.bytes > 0 {
                    stop.send_replace(true);
                }
            },
        )
        .await;
        assert!(root.join("Empty").is_dir());
        if cancel_early {
            assert!(result
                .unwrap_err()
                .to_string()
                .contains("completed items remain"));
            assert!(!root.join("binary.bin").exists());
        } else {
            result.unwrap();
            assert_eq!(
                std::fs::read(root.join("binary.bin")).unwrap(),
                super::tests::Memory::new(false).data
            );
            let plan = tree::remote(&service, entry("root@opaque", "Root", true, 0))
                .await
                .unwrap();
            assert!(execute(
                download_plan(plan, temp.path()),
                service,
                &cancel,
                &mut |_| {}
            )
            .await
            .is_err());
        }
    }
}
#[tokio::test]
async fn download_selection_keeps_files_and_multiple_folder_roots_separate() {
    let service = provider(None);
    let memory = super::tests::Memory::new(false);
    let temp = tempfile::tempdir().unwrap();
    let folder = temp.path().canonicalize().unwrap();
    let catalog = Arc::new(catalog::Catalog::new(true).unwrap());
    for root in [
        entry(
            "single@opaque",
            "single.bin",
            false,
            memory.data.len() as u64,
        ),
        entry("root@opaque", "Root", true, 0),
        entry("second-root@opaque", "Other empty folder", true, 0),
    ] {
        catalog.add(None, vec![(root, None)]).unwrap();
    }
    let job = selected_downloads(catalog, folder.clone()).unwrap().0;
    let (_, cancel) = watch::channel(false);
    assert_eq!(
        execute(job, service, &cancel, &mut |_| {}).await.unwrap(),
        folder.to_string_lossy()
    );
    assert_eq!(
        std::fs::read(folder.join("single.bin")).unwrap(),
        memory.data
    );
    assert_eq!(
        std::fs::read(folder.join("Root/binary.bin")).unwrap(),
        memory.data
    );
    assert!(folder.join("Root/Empty").is_dir());
    assert!(folder.join("Other empty folder").is_dir());
    assert_eq!(std::fs::read_dir(folder).unwrap().count(), 3);
}

#[tokio::test]
async fn folder_copy_refuses_a_descendant_before_creating_anything() {
    let service = provider(None);
    let plan = tree::remote(&service, entry("root@opaque", "Root", true, 0))
        .await
        .unwrap();
    let (_, cancel) = watch::channel(false);
    let error = execute(
        Job::Tree {
            tree: plan,
            target: tree::Target::Remote("empty@opaque".into()),
        },
        service,
        &cancel,
        &mut |_| {},
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("descendant"));
}

/// Opt in with SHELLCANVAS_TEST_HOST / USER / KEY; only writes inside a fresh
/// UUID directory, removes its own entries individually, and reports leftovers.
#[tokio::test]
#[ignore]
async fn live_folder_roundtrip() -> Result<()> {
    use shellcanvas_core::*;
    let connection = Connection::connect(ConnectOptions {
        host: std::env::var("SHELLCANVAS_TEST_HOST")?,
        username: std::env::var("SHELLCANVAS_TEST_USER")?,
        key_path: std::env::var("SHELLCANVAS_TEST_KEY")?,
        port: 22,
        password: None,
        passphrase: None,
    })
    .await?;
    let service = Arc::new(connection.text_files().await?);
    let transfer: Arc<dyn FileTransferService> = service.clone();
    let fs = SftpFileSystem(connection.sftp().await?);
    let remote_root = service
        .make_directory(
            "/tmp",
            &format!("shellcanvas-folders-{}", uuid::Uuid::new_v4()),
        )
        .await?;
    println!("Disposable fixture: {remote_root}");
    let local = tempfile::tempdir()?;
    let input = local.path().join("Folder");
    std::fs::create_dir_all(input.join("Nested/Empty"))?;
    let bytes: Vec<u8> = (0..1048593).map(|i| (i % 251) as u8).collect();
    std::fs::write(input.join("Nested/Unicode 🌍.bin"), &bytes)?;
    std::fs::write(input.join("zero.bin"), [])?;
    #[cfg(windows)]
    let clipboard_paths =
        if let Some(expected) = std::env::var_os("SHELLCANVAS_TEST_CLIPBOARD_FOLDER") {
            let paths = crate::windows_file_input::files()
                .map_err(anyhow::Error::msg)?
                .context("No Explorer file list on clipboard")?;
            anyhow::ensure!(
                paths == vec![PathBuf::from(expected)],
                "Clipboard does not match the explicitly selected fixture"
            );
            Some(paths)
        } else {
            None
        };
    #[cfg(not(windows))]
    let clipboard_paths: Option<Vec<PathBuf>> = None;
    let input = clipboard_paths
        .as_ref()
        .map(|paths| paths[0].clone())
        .unwrap_or(input);
    let plan = tree::local(input.clone())?;
    let (_stop, scanning) = watch::channel(false);
    let metadata = tree::scan(
        tree::local(input.clone())?,
        transfer.clone(),
        true,
        &scanning,
        &mut |_| {},
    )
    .await?;
    let total = metadata.size();
    let expected: Vec<_> = (1..=metadata.len())
        .map(|id| {
            let node = metadata.get(id).unwrap();
            let bytes = if node.entry.kind == "file" {
                Some(std::fs::read(&node.entry.path).unwrap())
            } else {
                None
            };
            (node.display.split('\\').collect::<PathBuf>(), bytes)
        })
        .collect();
    let upload = if let Some(paths) = clipboard_paths {
        clipboard_uploads(paths, remote_root.clone())
            .map_err(anyhow::Error::msg)?
            .pop()
            .unwrap()
            .0
    } else {
        Job::Tree {
            tree: plan,
            target: tree::Target::Remote(remote_root.clone()),
        }
    };
    let verify = |out: &Path| -> Result<()> {
        for (relative, bytes) in &expected {
            let path = out.join(relative);
            if let Some(bytes) = bytes {
                anyhow::ensure!(std::fs::read(path)? == *bytes, "File bytes differ");
            } else {
                anyhow::ensure!(path.is_dir(), "Empty folder missing");
            }
        }
        Ok(())
    };
    let (_, cancel) = watch::channel(false);
    let work: Result<()> = async {
        let uploaded = execute(upload, transfer.clone(), &cancel, &mut |_| {}).await?;
        let selected = fs.list(Some(&remote_root)).await?.entries.into_iter().find(|e| e.path == uploaded).context("Uploaded folder missing")?;
        let plan = tree::remote(&transfer, selected.clone()).await?;
        let metadata = scanned(transfer.clone(), selected.clone(), true).await?;
        anyhow::ensure!(metadata.len() as usize == expected.len() && metadata.size() == total, "Manifest mismatch");
        let out = local.path().join("download"); std::fs::create_dir(&out)?;
        execute(download_plan(plan, &out), transfer.clone(), &cancel, &mut |_| {}).await?;
        verify(&out)?;
        let destination = service.make_directory(&remote_root, "Copy destination").await?;
        let copied = execute(Job::Tree { tree: tree::remote(&transfer, selected).await?, target: tree::Target::Remote(destination.clone()) }, transfer.clone(), &cancel, &mut |_| {}).await?;
        let selected = fs.list(Some(&destination)).await?.entries.into_iter().find(|e| e.path == copied).unwrap();
        let out2 = local.path().join("copy"); std::fs::create_dir(&out2)?;
        execute(download_plan(tree::remote(&transfer, selected).await?, &out2), transfer.clone(), &cancel, &mut |_| {}).await?;
        verify(&out2)?;
        println!("Local folder upload, remote folder copy, downloads, Unicode names, zero-byte file and empty folders: exact byte verification passed");
        Ok(())
    }.await;
    // Enumerate only this newly created root. Delete leaves before parents with
    // fresh revisions; remove_entry refuses nonempty directories and follows no links.
    anyhow::ensure!(
        remote_root.starts_with("/tmp/shellcanvas-folders-") && !remote_root[5..].contains('/')
    );
    let mut paths = vec![remote_root.clone()];
    let mut i = 0;
    while i < paths.len() {
        for entry in fs.list(Some(&paths[i])).await?.entries {
            anyhow::ensure!(entry.path.starts_with(&(remote_root.clone() + "/")));
            if entry.kind == "directory" {
                paths.push(entry.path);
            } else {
                service.remove_entry(&entry.path, &entry.revision).await?;
            }
        }
        i += 1;
    }
    for path in paths.into_iter().rev() {
        let location = fs.locate(&path).await?;
        let entry = fs
            .list(location.parent.as_deref())
            .await?
            .entries
            .into_iter()
            .find(|e| e.path == path)
            .context("Cleanup item missing")?;
        service.remove_entry(&entry.path, &entry.revision).await?;
    }
    println!("Disposable remote fixture removed");
    work
}
