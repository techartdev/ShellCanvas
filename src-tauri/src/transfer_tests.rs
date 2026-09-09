// SPDX-License-Identifier: MPL-2.0
use super::*;

#[test]
fn clipboard_uploads_capture_root_metadata_and_refuse_duplicate_names() {
    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("local 🌍.bin");
    std::fs::write(&first, b"clipboard source").unwrap();
    let second = directory.path().join("second.txt");
    std::fs::write(&second, b"second").unwrap();
    let jobs = clipboard_uploads(vec![first.clone(), second], "opaque@destination".into()).unwrap();
    assert_eq!(jobs.len(), 1);
    let (Job::Selection { catalog, parent }, name, size, direction) =
        jobs.into_iter().next().unwrap()
    else {
        panic!("Expected selection upload")
    };
    assert_eq!(catalog.len(), 2);
    assert_eq!(catalog.get(1).unwrap().entry.name, "local 🌍.bin");
    assert_eq!(catalog.get(1).unwrap().local.as_ref().unwrap().size, 16);
    assert_eq!(parent, "opaque@destination");
    assert_eq!(
        (name.as_str(), size, direction),
        ("2 clipboard items", 22, "upload")
    );
    assert!(clipboard_uploads(vec![first.clone(), first.clone()], "dest".into()).is_err());
    assert!(clipboard_uploads(vec![first, directory.path().to_path_buf()], "dest".into()).is_ok());
    assert!(clipboard_uploads(vec![], "dest".into()).is_err());
}
use async_trait::async_trait;
use shellcanvas_core::{FileLocation, TransferFile, TransferReader, TransferWriter};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};
pub(super) struct Memory {
    pub(super) data: Vec<u8>,
    writes: Mutex<Vec<u8>>,
    aborts: AtomicUsize,
    commits: AtomicUsize,
    fail_verify: bool,
}
impl Memory {
    pub(super) fn new(fail_verify: bool) -> Arc<Self> {
        Arc::new(Self {
            data: vec![0xA5; TRANSFER_CHUNK * 3 + 17],
            writes: Mutex::new(Vec::new()),
            aborts: AtomicUsize::new(0),
            commits: AtomicUsize::new(0),
            fail_verify,
        })
    }
}
struct Read {
    memory: Arc<Memory>,
    offset: usize,
}
#[async_trait]
impl TransferReader for Read {
    fn file(&self) -> TransferFile {
        TransferFile {
            location: FileLocation {
                path: "object@1".into(),
                name: "binary.bin".into(),
                parent: Some("volume@1".into()),
            },
            size: self.memory.data.len() as u64,
        }
    }
    async fn read(&mut self) -> Result<Vec<u8>> {
        let end = (self.offset + TRANSFER_CHUNK).min(self.memory.data.len());
        let bytes = self.memory.data[self.offset..end].to_vec();
        self.offset = end;
        Ok(bytes)
    }
    async fn finish(&mut self) -> Result<()> {
        if self.memory.fail_verify {
            bail!("Source changed");
        }
        Ok(())
    }
    async fn abort(&mut self) -> Result<()> {
        self.memory.aborts.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
struct Write {
    memory: Arc<Memory>,
}
#[async_trait]
impl TransferWriter for Write {
    async fn write(&mut self, bytes: &[u8]) -> Result<()> {
        assert!(bytes.len() <= TRANSFER_CHUNK);
        self.memory.writes.lock().unwrap().extend_from_slice(bytes);
        Ok(())
    }
    async fn finish(&mut self) -> Result<FileLocation> {
        self.memory.commits.fetch_add(1, Ordering::SeqCst);
        Ok(FileLocation {
            path: "uploaded@1".into(),
            name: "binary.bin".into(),
            parent: Some("volume@1".into()),
        })
    }
    async fn abort(&mut self) -> Result<()> {
        self.memory.aborts.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
#[async_trait]
impl FileTransferService for Memory {
    async fn download(self: Arc<Self>, _: &str, _: &str) -> Result<Box<dyn TransferReader>> {
        Ok(Box::new(Read {
            memory: self,
            offset: 0,
        }))
    }
    async fn upload(self: Arc<Self>, _: &str, _: &str, _: u64) -> Result<Box<dyn TransferWriter>> {
        Ok(Box::new(Write { memory: self }))
    }
}
fn download_job(destination: &Path) -> Job {
    Job::Download {
        destination: destination.into(),
        path: "object@1".into(),
        revision: "revision".into(),
    }
}
fn copy_job() -> Job {
    Job::Copy {
        path: "object@1".into(),
        revision: "revision".into(),
        parent: "folder@other".into(),
        name: "binary.bin".into(),
    }
}

#[tokio::test]
async fn clipboard_selection_streams_many_roots_through_one_job() {
    let directory = tempfile::tempdir().unwrap();
    let mut paths = Vec::new();
    let mut expected = Vec::new();
    for index in 0..128u16 {
        let path = directory.path().join(format!("item-{index}.bin"));
        let bytes = index.to_le_bytes().repeat(1025);
        std::fs::write(&path, &bytes).unwrap();
        expected.extend_from_slice(&bytes);
        paths.push(path);
    }
    let mut jobs = clipboard_uploads(paths, "target@folder".into()).unwrap();
    assert_eq!(jobs.len(), 1);
    let memory = Memory::new(false);
    let (_, canceled) = watch::channel(false);
    let mut last = (0, 0);
    let result = execute(
        jobs.pop().unwrap().0,
        memory.clone(),
        &canceled,
        &mut |event| {
            last = (event.bytes, event.total);
        },
    )
    .await
    .unwrap();
    assert_eq!(result, "target@folder");
    assert_eq!(*memory.writes.lock().unwrap(), expected);
    assert_eq!(memory.commits.load(Ordering::SeqCst), 128);
    assert_eq!(last, (expected.len() as u64, expected.len() as u64));
}

#[tokio::test]
async fn clipboard_selection_refuses_changed_sources_before_opening_upload() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("source.bin");
    std::fs::write(&path, b"original").unwrap();
    let job = clipboard_uploads(vec![path.clone()], "target".into())
        .unwrap()
        .pop()
        .unwrap()
        .0;
    std::fs::write(&path, b"changed length since preparation").unwrap();
    let memory = Memory::new(false);
    let (_, canceled) = watch::channel(false);
    assert!(execute(job, memory.clone(), &canceled, &mut |_| {})
        .await
        .is_err());
    assert!(memory.writes.lock().unwrap().is_empty());
    assert_eq!(memory.commits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn clipboard_selection_cancellation_preserves_completed_roots_and_stops_following_items() {
    let directory = tempfile::tempdir().unwrap();
    let paths: Vec<_> = (0..3)
        .map(|index| {
            let path = directory.path().join(format!("{index}.bin"));
            std::fs::write(&path, [index as u8; 16]).unwrap();
            path
        })
        .collect();
    let job = clipboard_uploads(paths, "target@folder".into())
        .unwrap()
        .pop()
        .unwrap()
        .0;
    let memory = Memory::new(false);
    let (cancel, canceled) = watch::channel(false);
    let result = execute(job, memory.clone(), &canceled, &mut |_| {
        if memory.commits.load(Ordering::SeqCst) == 1 {
            cancel.send(true).unwrap();
        }
    })
    .await;
    assert!(
        format!("{:#}", result.unwrap_err()).contains("completed items remain at target@folder")
    );
    assert_eq!(memory.commits.load(Ordering::SeqCst), 1);
    assert_eq!(*memory.writes.lock().unwrap(), [0u8; 16]);
}

#[tokio::test]
async fn queued_transfer_keeps_its_provider_and_cannot_follow_source_replacement() {
    use crate::{connection_resource::ConnectionResource, workspace_services::WorkspaceServices};
    use shellcanvas_services::{ConnectionIdentity, ConnectionLifecycle};
    struct Lifecycle;
    #[async_trait]
    impl ConnectionLifecycle for Lifecycle {
        fn is_connected(&self) -> bool {
            true
        }
        async fn disconnect(&self) -> Result<()> {
            Ok(())
        }
    }
    let resource = |instance| {
        ConnectionResource::new(
            ConnectionIdentity {
                instance,
                generation: 1,
                adapter: "fixture.files".into(),
            },
            Arc::new(Lifecycle),
        )
    };
    let old = resource(201);
    let fresh = resource(202);
    let old_memory = Memory::new(false);
    let fresh_memory = Memory::new(false);
    let mut workspace = WorkspaceServices::new(vec![old.clone()]).unwrap();
    workspace.bind_transfers(&old, old_memory.clone()).unwrap();
    let mut registry = TransferRegistry::default();
    let ticket = registry
        .add(
            10,
            workspace.transfers.clone().unwrap(),
            vec![(copy_job(), "copy".into(), 0, "copy")],
        )
        .unwrap()
        .remove(0);
    let mut replacement = WorkspaceServices::new(vec![fresh.clone()]).unwrap();
    replacement
        .bind_transfers(&fresh, fresh_memory.clone())
        .unwrap();
    let retired = workspace
        .replace_source(old.identity(), replacement)
        .unwrap();
    let claimed = registry.claim(10, ticket.id).unwrap();
    assert!(
        execute(claimed.job, claimed.service, &claimed.cancel, &mut |_| {})
            .await
            .is_err()
    );
    assert_eq!(old_memory.commits.load(Ordering::SeqCst), 0);
    assert_eq!(fresh_memory.commits.load(Ordering::SeqCst), 0);
    // A newly prepared ticket explicitly uses the replacement source.
    let fresh_ticket = registry
        .add(
            10,
            workspace.transfers.clone().unwrap(),
            vec![(copy_job(), "copy".into(), 0, "copy")],
        )
        .unwrap()
        .remove(0);
    let claimed = registry.claim(10, fresh_ticket.id).unwrap();
    execute(claimed.job, claimed.service, &claimed.cancel, &mut |_| {})
        .await
        .unwrap();
    assert_eq!(fresh_memory.commits.load(Ordering::SeqCst), 1);
    retired.close().await.unwrap();
    workspace.disconnect().await.unwrap();
}
#[tokio::test]
async fn remote_copy_streams_and_publishes_once_after_source_verification() {
    let memory = Memory::new(false);
    let (cancel, canceled) = watch::channel(false);
    let path = execute(copy_job(), memory.clone(), &canceled, &mut |event| {
        // Publication already started; a late request cannot hide success.
        if event.phase == "finishing" {
            cancel.send_replace(true);
        }
    })
    .await
    .unwrap();
    assert_eq!(path, "uploaded@1");
    assert_eq!(*memory.writes.lock().unwrap(), memory.data);
    assert_eq!(memory.commits.load(Ordering::SeqCst), 1);
    assert_eq!(memory.aborts.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn remote_copy_cancellation_and_source_change_abort_both_handles_without_publication() {
    for fail_verify in [false, true] {
        let memory = Memory::new(fail_verify);
        let (cancel, canceled) = watch::channel(false);
        let result = execute(copy_job(), memory.clone(), &canceled, &mut |event| {
            if !fail_verify && event.bytes > 0 {
                cancel.send_replace(true);
            }
        })
        .await
        .unwrap_err();
        assert!(result.to_string().contains(if fail_verify {
            "Source changed"
        } else {
            "Transfer canceled"
        }));
        assert_eq!(memory.commits.load(Ordering::SeqCst), 0);
        assert_eq!(memory.aborts.load(Ordering::SeqCst), 2);
    }
}
fn upload_job(path: &Path) -> Job {
    let (file, size, modified) = source(path).unwrap();
    Job::Upload {
        file,
        size,
        modified,
        parent: "volume@1".into(),
        name: "binary.bin".into(),
    }
}
#[tokio::test]
async fn streams_binary_files_and_refuses_local_overwrite() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("download.bin");
    let memory = Memory::new(false);
    let (_, cancel) = watch::channel(false);
    let mut counts = Vec::new();
    execute(
        download_job(&destination),
        memory.clone(),
        &cancel,
        &mut |event| counts.push(event.bytes),
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), memory.data);
    assert!(counts.windows(2).all(|pair| pair[1] >= pair[0]));
    assert!(execute(
        download_job(&destination),
        memory.clone(),
        &cancel,
        &mut |_| {}
    )
    .await
    .unwrap_err()
    .to_string()
    .contains("already exists"));
    execute(
        upload_job(&destination),
        memory.clone(),
        &cancel,
        &mut |_| {},
    )
    .await
    .unwrap();
    assert_eq!(*memory.writes.lock().unwrap(), memory.data);
    assert_eq!(memory.commits.load(Ordering::SeqCst), 1);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}
#[tokio::test]
async fn cancellation_and_source_failure_remove_partial_downloads() {
    for fail in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let memory = Memory::new(fail);
        let (stop, cancel) = watch::channel(false);
        let result = execute(
            download_job(&dir.path().join("output.bin")),
            memory.clone(),
            &cancel,
            &mut |event| {
                if !fail && event.bytes > 0 {
                    stop.send_replace(true);
                }
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(memory.aborts.load(Ordering::SeqCst), 1);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
#[tokio::test]
async fn canceled_upload_never_publishes_and_late_cancel_preserves_confirmed_completion() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("input.bin");
    let memory = Memory::new(false);
    std::fs::write(&input, &memory.data).unwrap();
    let (stop, cancel) = watch::channel(false);
    assert!(
        execute(upload_job(&input), memory.clone(), &cancel, &mut |event| {
            if event.bytes > 0 {
                stop.send_replace(true);
            }
        })
        .await
        .is_err()
    );
    assert_eq!(memory.commits.load(Ordering::SeqCst), 0);
    assert_eq!(memory.aborts.load(Ordering::SeqCst), 1);
    let (stop, cancel) = watch::channel(false);
    execute(upload_job(&input), memory.clone(), &cancel, &mut |event| {
        if event.phase == "finishing" {
            stop.send_replace(true);
        }
    })
    .await
    .unwrap();
    assert_eq!(memory.commits.load(Ordering::SeqCst), 1);
}
#[test]
fn registry_rejects_cross_host_controls_and_releases_only_the_closed_host() {
    let mut registry = TransferRegistry::default();
    let add = |r: &mut TransferRegistry, owner| {
        r.add(
            owner,
            Memory::new(false),
            vec![(
                download_job(Path::new("unused")),
                "file".into(),
                0,
                "download",
            )],
        )
        .unwrap()[0]
            .id
    };
    let a = add(&mut registry, 1);
    let b = add(&mut registry, 2);
    assert!(registry.claim(1, b).is_err());
    assert!(registry.cancel(1, b).is_err());
    let cancel = registry.claim(1, a).unwrap().cancel;
    assert!(registry.claim(1, a).is_err());
    registry.close_session(1);
    assert!(*cancel.borrow());
    assert!(registry.claim(2, b).is_ok());
}
#[test]
fn batch_download_names_never_escape_or_alias_the_chosen_folder() {
    for name in [
        "",
        ".",
        "..",
        "../escape",
        "C:\\escape",
        "a/b",
        "bad:stream",
        "NUL.txt",
        "COM1",
        "LPT².txt",
        "trailing.",
        "trailing ",
    ] {
        assert!(super::download_name(name).is_err(), "{name}");
    }
    let directory = tempfile::tempdir().unwrap();
    let names = vec!["Notes 🌍.txt".into(), "second.bin".into()];
    let paths = super::download_destinations(directory.path(), &names).unwrap();
    assert_eq!(paths[0], directory.path().join(&names[0]));
    assert!(
        super::download_destinations(directory.path(), &["A.txt".into(), "a.txt".into()]).is_err()
    );
    std::fs::write(&paths[1], b"keep").unwrap();
    assert!(super::download_destinations(directory.path(), &names).is_err());
    assert_eq!(std::fs::read(&paths[1]).unwrap(), b"keep");
    assert!(!paths[0].exists());
}
