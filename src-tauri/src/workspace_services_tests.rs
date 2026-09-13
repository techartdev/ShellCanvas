// SPDX-License-Identifier: MPL-2.0
use super::*;
use std::sync::{atomic::AtomicUsize, Mutex};
use tokio::sync::Notify;

fn file_workspace(resource: &Arc<ConnectionResource>) -> WorkspaceServices {
    let mut workspace = WorkspaceServices::new(vec![resource.clone()]).unwrap();
    workspace
        .bind_files(resource, Arc::new(Files::default()))
        .unwrap();
    workspace
}

#[tokio::test]
async fn browsing_and_text_read_support_are_reported_independently_of_write_permission() {
    struct ReadOnlyText;
    #[async_trait]
    impl TextFileService for ReadOnlyText {
        async fn read_text(&self, path: &str) -> Result<TextDocument> {
            Ok(TextDocument {
                path: path.into(),
                name: "note".into(),
                parent: None,
                text: "read only".into(),
                revision: "r1".into(),
                writable: false,
                save_requires_confirmation: false,
            })
        }
        async fn create_text(&self, _: &str, _: &str, _: &str) -> Result<TextDocument> {
            bail!("Read only")
        }
        async fn save_text(&self, _: &str, _: &str, _: &str) -> Result<TextDocument> {
            bail!("Read only")
        }
    }
    let (resource, _) = source(190, "fixture.read-only");
    let mut workspace = file_workspace(&resource);
    let status = workspace.status();
    let read = status
        .services
        .iter()
        .find(|service| service.capability == "files.read")
        .unwrap();
    assert_eq!(read.state, "available");
    assert_eq!(
        read.operations.as_ref().unwrap(),
        &["list", "locate", "preview"]
    );
    workspace
        .bind_text(&resource, Arc::new(ReadOnlyText))
        .unwrap();
    workspace.advertise_capabilities(&["files.read".into()]);
    let status = workspace.status();
    let read = status
        .services
        .iter()
        .find(|service| service.capability == "files.read")
        .unwrap();
    assert!(read.operations.as_ref().unwrap().contains(&"readText"));
    assert_eq!(
        status
            .services
            .iter()
            .find(|service| service.capability == "files.edit")
            .unwrap()
            .state,
        "unsupported"
    );
    assert_eq!(
        workspace
            .text
            .as_ref()
            .unwrap()
            .read_text("opaque:note")
            .await
            .unwrap()
            .text,
        "read only"
    );
    workspace.disconnect().await.unwrap();
}

#[tokio::test]
async fn retirement_failure_is_post_commit_and_does_not_discard_the_new_source() {
    struct FailingCleanup;
    #[async_trait]
    impl ConnectionLifecycle for FailingCleanup {
        fn is_connected(&self) -> bool {
            true
        }
        async fn disconnect(&self) -> Result<()> {
            bail!("fixture cleanup failed")
        }
    }
    let old = ConnectionResource::new(
        ConnectionIdentity {
            instance: 150,
            generation: 1,
            adapter: "fixture.cleanup".into(),
        },
        Arc::new(FailingCleanup),
    );
    let (fresh, _) = source(151, "fixture.files");
    let mut workspace = file_workspace(&old);
    let retired = workspace
        .replace_source(old.identity(), file_workspace(&fresh))
        .unwrap();
    assert!(retired
        .close()
        .await
        .unwrap_err()
        .contains("cleanup failed"));
    assert_eq!(workspace.identities(), vec![fresh.identity().clone()]);
    workspace
        .files
        .as_ref()
        .unwrap()
        .list(Some("opaque@files"))
        .await
        .unwrap();
    workspace.disconnect().await.unwrap();
}

#[tokio::test]
async fn source_replacement_preserves_live_console_and_other_workspace_lease() {
    let (old, old_transport) = source(101, "fixture.files");
    let (console_source, console_transport) = source(102, "fixture.console");
    let (fresh, fresh_transport) = source(103, "fixture.files.v2");
    let files = Arc::new(Files::default());
    files.delay.store(true, Ordering::SeqCst);
    let mut workspace = WorkspaceServices::new(vec![old.clone(), console_source.clone()]).unwrap();
    workspace.bind_files(&old, files.clone()).unwrap();
    workspace
        .bind_terminal(&console_source, Arc::new(Console::default()))
        .unwrap();
    let survivor = file_workspace(&old);
    let old_files = workspace.files.clone().unwrap();
    let pending_handle = old_files.clone();
    let pending = tokio::spawn(async move { pending_handle.preview("opaque@document").await });
    files.entered.notified().await;
    let terminal = workspace.terminal.clone().unwrap();
    let mut stream = terminal.open(TerminalSize::new(80, 24)).await.unwrap();
    let prepared = file_workspace(&fresh);
    assert_eq!(workspace.status().source_revision, 0);
    // Preparing a replacement has no effect on current services.
    old_files.list(Some("opaque@files")).await.unwrap();
    let retired = workspace.replace_source(old.identity(), prepared).unwrap();
    assert_eq!(workspace.status().source_revision, 1);
    assert!(workspace
        .check_source(&ServiceRole::Files, Some(old.identity()))
        .is_err());
    assert!(workspace.check_source(&ServiceRole::Files, None).is_err());
    workspace
        .check_source(&ServiceRole::Files, Some(fresh.identity()))
        .unwrap();
    workspace
        .check_source(&ServiceRole::Console, Some(console_source.identity()))
        .unwrap();
    workspace.check_source(&ServiceRole::Console, None).unwrap();
    assert!(workspace
        .check_source(&ServiceRole::Files, Some(console_source.identity()))
        .is_err());
    assert!(Arc::ptr_eq(&terminal, workspace.terminal.as_ref().unwrap()));
    assert!(old_files.list(Some("opaque@files")).await.is_err());
    files.release.notify_one();
    assert!(pending.await.unwrap().is_err());
    stream.writer.write(b"still running").await.unwrap();
    assert_eq!(stream.reader.read().await.unwrap(), Some(vec![0, 255, 42]));
    workspace
        .files
        .as_ref()
        .unwrap()
        .list(Some("opaque@files"))
        .await
        .unwrap();
    retired.close().await.unwrap();
    assert_eq!(old_transport.closes.load(Ordering::SeqCst), 0);
    survivor
        .files
        .as_ref()
        .unwrap()
        .list(Some("opaque@files"))
        .await
        .unwrap();
    assert_eq!(console_transport.closes.load(Ordering::SeqCst), 0);
    let new_files = workspace.files.clone().unwrap();
    workspace.disconnect().await.unwrap();
    assert!(new_files.list(Some("opaque@files")).await.is_err());
    assert!(stream.writer.write(b"closed").await.is_err());
    assert_eq!(fresh_transport.closes.load(Ordering::SeqCst), 1);
    assert_eq!(console_transport.closes.load(Ordering::SeqCst), 1);
    survivor.disconnect().await.unwrap();
    assert_eq!(old_transport.closes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn rejected_replacement_never_changes_current_bindings_and_releases_candidate() {
    let (old, _) = source(110, "fixture.files");
    let (console, _) = source(111, "fixture.console");
    let mut workspace = WorkspaceServices::new(vec![old.clone(), console.clone()]).unwrap();
    workspace
        .bind_files(&old, Arc::new(Files::default()))
        .unwrap();
    workspace
        .bind_terminal(&console, Arc::new(Console::default()))
        .unwrap();
    let original = workspace.files.clone().unwrap();
    // A files replacement cannot claim the surviving console's family.
    let (wrong, wrong_transport) = source(112, "fixture.wrong");
    let mut candidate = file_workspace(&wrong);
    candidate
        .bind_terminal(&wrong, Arc::new(Console::default()))
        .unwrap();
    assert!(workspace.replace_source(old.identity(), candidate).is_err());
    wrong.disconnect().await.unwrap();
    assert_eq!(wrong_transport.closes.load(Ordering::SeqCst), 1);
    // Nor can it reuse another connection's instance or the old generation.
    for id in [110, 111] {
        let (collision, _) = source(id, "fixture.collision");
        assert!(workspace
            .replace_source(old.identity(), file_workspace(&collision))
            .is_err());
        collision.disconnect().await.unwrap();
    }
    let (disconnected, _) = source(113, "fixture.failed");
    let candidate = file_workspace(&disconnected);
    disconnected.disconnect().await.unwrap();
    assert!(workspace.replace_source(old.identity(), candidate).is_err());
    assert!(Arc::ptr_eq(&original, workspace.files.as_ref().unwrap()));
    original.list(Some("opaque@files")).await.unwrap();
    // A second concurrent proposal cannot overwrite an already committed one.
    let (first, _) = source(114, "fixture.first");
    workspace
        .replace_source(old.identity(), file_workspace(&first))
        .unwrap()
        .close()
        .await
        .unwrap();
    let (late, _) = source(115, "fixture.late");
    assert!(workspace
        .replace_source(old.identity(), file_workspace(&late))
        .is_err());
    // A->B->A with the original generation must not make an old approval valid again.
    let (reused, _) = source(110, "fixture.files");
    assert!(workspace
        .replace_source(first.identity(), file_workspace(&reused))
        .is_err());
    reused.disconnect().await.unwrap();
    assert_eq!(
        workspace.status().services[1].source,
        Some(first.identity().clone())
    );
    workspace
        .files
        .as_ref()
        .unwrap()
        .list(Some("opaque@files"))
        .await
        .unwrap();
    late.disconnect().await.unwrap();
    workspace.disconnect().await.unwrap();
}

#[tokio::test]
async fn selected_unavailable_family_can_recover_and_lose_capabilities_again() {
    let (old, _) = source(120, "fixture.unavailable");
    let (fresh, _) = source(121, "fixture.files");
    let (last, _) = source(122, "fixture.no-files");
    let mut workspace = WorkspaceServices::new(vec![old.clone()]).unwrap();
    workspace.select_service(&old, ServiceRole::Files).unwrap();
    workspace.advertise_capabilities(&[]);
    assert_eq!(workspace.status().services[1].state, "unsupported");
    assert_eq!(
        workspace.status().services[1].source,
        Some(old.identity().clone())
    );
    workspace
        .replace_source(old.identity(), file_workspace(&fresh))
        .unwrap()
        .close()
        .await
        .unwrap();
    assert_eq!(workspace.status().services[1].state, "available");
    let handle = workspace.files.clone().unwrap();
    let mut candidate = WorkspaceServices::new(vec![last.clone()]).unwrap();
    candidate.select_service(&last, ServiceRole::Files).unwrap();
    workspace
        .replace_source(fresh.identity(), candidate)
        .unwrap()
        .close()
        .await
        .unwrap();
    assert!(workspace.files.is_none());
    assert!(handle.preview("opaque@document").await.is_err());
    assert_eq!(workspace.status().services[1].state, "unsupported");
    assert_eq!(
        workspace.status().services[1].source,
        Some(last.identity().clone())
    );
    workspace.disconnect().await.unwrap();
}

#[tokio::test]
async fn higher_generation_replacement_and_candidate_drop_keep_correct_lifetimes() {
    let (old, _) = source(130, "fixture.files");
    let transport = Arc::new(Transport::default());
    let fresh = ConnectionResource::new(
        ConnectionIdentity {
            generation: 2,
            ..old.identity().clone()
        },
        transport,
    );
    let mut workspace = file_workspace(&old);
    // Abandoning a prepared proposal does not retire any active source.
    let (abandoned, _) = source(131, "fixture.abandoned");
    drop(file_workspace(&abandoned));
    workspace
        .files
        .as_ref()
        .unwrap()
        .list(Some("opaque@files"))
        .await
        .unwrap();
    workspace
        .replace_source(old.identity(), file_workspace(&fresh))
        .unwrap()
        .close()
        .await
        .unwrap();
    workspace
        .files
        .as_ref()
        .unwrap()
        .list(Some("opaque@files"))
        .await
        .unwrap();
    assert_eq!(workspace.identities(), vec![fresh.identity().clone()]);
    workspace.disconnect().await.unwrap();
    abandoned.disconnect().await.unwrap();
}

#[derive(Default)]
struct Transport {
    closed: AtomicBool,
    closes: AtomicUsize,
}
#[async_trait]
impl ConnectionLifecycle for Transport {
    fn is_connected(&self) -> bool {
        !self.closed.load(Ordering::SeqCst)
    }
    async fn disconnect(&self) -> Result<()> {
        self.closed.store(true, Ordering::SeqCst);
        self.closes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
fn source(id: u64, adapter: &str) -> (Arc<ConnectionResource>, Arc<Transport>) {
    let transport = Arc::new(Transport::default());
    (
        ConnectionResource::new(
            ConnectionIdentity {
                instance: id,
                generation: 1,
                adapter: adapter.into(),
            },
            transport.clone(),
        ),
        transport,
    )
}

#[tokio::test]
async fn status_identifies_each_service_source_and_preserves_partial_availability() {
    let (files, _) = source(51, "fixture.files");
    let (console, _) = source(52, "fixture.console");
    let mut workspace = WorkspaceServices::new(vec![files.clone(), console.clone()]).unwrap();
    workspace
        .bind_files(&files, Arc::new(Files::default()))
        .unwrap();
    workspace
        .bind_terminal(&console, Arc::new(Console::default()))
        .unwrap();
    let snapshot = serde_json::to_value(workspace.status()).unwrap();
    assert_eq!(snapshot["services"][0]["state"], "available");
    assert_eq!(snapshot["services"][0]["source"]["instance"], 52);
    assert_eq!(snapshot["services"][1]["state"], "available");
    assert_eq!(snapshot["services"][1]["source"]["instance"], 51);
    assert_eq!(snapshot["services"][2]["state"], "unsupported");
    assert_eq!(snapshot["services"][2]["source"]["instance"], 51);
    // A concrete interface must not invent capabilities rejected by discovery.
    workspace.advertise_capabilities(&["files.read".into()]);
    let narrowed = serde_json::to_value(workspace.status()).unwrap();
    assert_eq!(narrowed["services"][0]["state"], "unsupported");
    assert_eq!(narrowed["services"][1]["state"], "available");
    workspace.advertise_capabilities(&["terminal".into(), "files.read".into()]);
    files.disconnect().await.unwrap();
    let snapshot = serde_json::to_value(workspace.status()).unwrap();
    assert_eq!(snapshot["connected"], true);
    assert_eq!(snapshot["services"][0]["state"], "available");
    assert_eq!(snapshot["services"][1]["state"], "disconnected");
    assert!(snapshot["services"][1]["reason"]
        .as_str()
        .unwrap()
        .contains("closed"));
    console.disconnect().await.unwrap();
    assert!(!workspace.status().connected);
    workspace.disconnect().await.unwrap();
}
#[derive(Default)]
struct Files {
    calls: AtomicUsize,
    directory_closes: AtomicUsize,
    delay: AtomicBool,
    entered: Notify,
    release: Notify,
}
#[async_trait]
impl FileSystemProvider for Files {
    async fn volumes(&self) -> Result<FileVolumes> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(FileVolumes {
            revision: "fixture-volume-revision".into(),
            volumes: vec![],
            notices: vec!["fixture inventory".into()],
        })
    }
    async fn set_volume_mounted(&self, id: &str, revision: &str, mounted: bool) -> Result<()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(
            (id, revision, mounted),
            ("opaque-volume", "fixture-volume-revision", true)
        );
        self.entered.notify_one();
        if self.delay.load(Ordering::SeqCst) {
            self.release.notified().await;
        }
        Ok(())
    }
    async fn open_directory(
        self: Arc<Self>,
        path: Option<&str>,
    ) -> Result<Box<dyn DirectoryReader>> {
        assert_eq!(path, Some("opaque@files"));
        Ok(Box::new(TestBrowserReader {
            files: self,
            closed: false,
        }))
    }
    async fn list(&self, path: Option<&str>) -> Result<Directory> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(path, Some("opaque@files"));
        Ok(Directory {
            path: "opaque@files".into(),
            name: "Files".into(),
            parent: None,
            home: None,
            roots: vec![],
            entries: vec![],
        })
    }
    async fn locate(&self, path: &str) -> Result<FileLocation> {
        Ok(FileLocation {
            path: path.into(),
            name: "Item".into(),
            parent: None,
        })
    }
    async fn preview(&self, _: &str) -> Result<String> {
        self.entered.notify_one();
        if self.delay.load(Ordering::SeqCst) {
            self.release.notified().await;
        }
        Ok("Late file contents".into())
    }
}
#[tokio::test]
async fn volume_discovery_and_changes_reach_bound_provider_and_reject_retired_bindings() {
    let (resource, _) = source(198, "fixture.volumes");
    let files = Arc::new(Files::default());
    let mut workspace = WorkspaceServices::new(vec![resource.clone()]).unwrap();
    workspace.bind_files(&resource, files.clone()).unwrap();
    let bound = workspace.files.clone().unwrap();
    assert_eq!(
        bound.volumes().await.unwrap().revision,
        "fixture-volume-revision"
    );
    bound
        .set_volume_mounted("opaque-volume", "fixture-volume-revision", true)
        .await
        .unwrap();
    assert_eq!(files.calls.load(Ordering::SeqCst), 2);
    resource.disconnect().await.unwrap();
    assert!(bound.volumes().await.is_err());
    assert!(bound
        .set_volume_mounted("opaque-volume", "fixture-volume-revision", true)
        .await
        .is_err());
    assert_eq!(files.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn disconnect_during_volume_change_reports_uncertain_outcome_without_retry() {
    let (resource, _) = source(199, "fixture.volumes");
    let files = Arc::new(Files::default());
    files.delay.store(true, Ordering::SeqCst);
    let mut workspace = WorkspaceServices::new(vec![resource.clone()]).unwrap();
    workspace.bind_files(&resource, files.clone()).unwrap();
    let bound = workspace.files.clone().unwrap();
    let task = tokio::spawn(async move {
        bound
            .set_volume_mounted("opaque-volume", "fixture-volume-revision", true)
            .await
    });
    files.entered.notified().await;
    resource.disconnect().await.unwrap();
    files.release.notify_one();
    let error = task.await.unwrap().unwrap_err().to_string();
    assert!(error.contains("uncertain"), "{error}");
    assert_eq!(files.calls.load(Ordering::SeqCst), 1);
}
struct TestBrowserReader {
    files: Arc<Files>,
    closed: bool,
}
impl TestBrowserReader {
    fn release(&mut self) {
        if !self.closed {
            self.closed = true;
            self.files.directory_closes.fetch_add(1, Ordering::SeqCst);
        }
    }
}
impl Drop for TestBrowserReader {
    fn drop(&mut self) {
        self.release();
    }
}
#[async_trait]
impl DirectoryReader for TestBrowserReader {
    async fn next(&mut self) -> Result<DirectoryPage> {
        if self.closed {
            bail!("Directory closed");
        }
        self.files.entered.notify_one();
        if self.files.delay.load(Ordering::SeqCst) {
            self.files.release.notified().await;
        }
        Ok(DirectoryPage {
            directory: self.files.list(Some("opaque@files")).await?,
            done: true,
        })
    }
    async fn close(&mut self) -> Result<()> {
        self.release();
        Ok(())
    }
}

#[tokio::test]
async fn directory_pages_and_cleanup_stay_with_their_source_after_replacement() {
    let (old, transport) = source(711, "fixture.directory");
    let (fresh, _) = source(712, "fixture.replacement");
    let files = Arc::new(Files::default());
    let mut workspace = WorkspaceServices::new(vec![old.clone()]).unwrap();
    workspace.bind_files(&old, files.clone()).unwrap();
    let mut survivor = WorkspaceServices::new(vec![old.clone()]).unwrap();
    survivor.bind_files(&old, files.clone()).unwrap();
    let captured = workspace.files.clone().unwrap();
    let mut reader = captured
        .clone()
        .open_directory(Some("opaque@files"))
        .await
        .unwrap();
    let mut independent = survivor
        .files
        .clone()
        .unwrap()
        .open_directory(Some("opaque@files"))
        .await
        .unwrap();
    files.delay.store(true, Ordering::SeqCst);
    let pending = tokio::spawn(async move {
        let result = reader.next().await;
        (reader, result)
    });
    files.entered.notified().await;
    let retired = workspace
        .replace_source(old.identity(), file_workspace(&fresh))
        .unwrap();
    files.release.notify_one();
    let (mut reader, result) = pending.await.unwrap();
    assert!(
        result.is_err(),
        "late old-source page must not reach the replacement workspace"
    );
    assert_eq!(files.directory_closes.load(Ordering::SeqCst), 1);
    reader.close().await.unwrap();
    assert!(reader.next().await.is_err());
    assert!(captured.open_directory(Some("opaque@files")).await.is_err());
    files.delay.store(false, Ordering::SeqCst);
    assert!(independent.next().await.unwrap().done);
    independent.close().await.unwrap();
    assert_eq!(files.directory_closes.load(Ordering::SeqCst), 2);
    retired.close().await.unwrap();
    assert_eq!(transport.closes.load(Ordering::SeqCst), 0);
    workspace.disconnect().await.unwrap();
    survivor.disconnect().await.unwrap();
    assert_eq!(transport.closes.load(Ordering::SeqCst), 1);
}
#[derive(Default)]
struct Console {
    bytes: Arc<Mutex<Vec<u8>>>,
    closes: Arc<AtomicUsize>,
    delay: AtomicBool,
    entered: Notify,
    release: Notify,
}
struct ConsoleReader;
struct ConsoleWriter {
    bytes: Arc<Mutex<Vec<u8>>>,
    closes: Arc<AtomicUsize>,
}
#[async_trait]
impl TerminalReader for ConsoleReader {
    async fn read(&mut self) -> Result<Option<Vec<u8>>> {
        Ok(Some(vec![0, 255, 42]))
    }
}
#[async_trait]
impl TerminalWriter for ConsoleWriter {
    async fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.bytes.lock().unwrap().extend(bytes);
        Ok(())
    }
    async fn resize(&mut self, _: TerminalSize) -> Result<()> {
        Ok(())
    }
    async fn close(&mut self) -> Result<()> {
        self.closes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
#[async_trait]
impl TerminalService for Console {
    async fn open(&self, _: TerminalSize) -> Result<TerminalStream> {
        self.entered.notify_one();
        if self.delay.load(Ordering::SeqCst) {
            self.release.notified().await;
        }
        Ok(TerminalStream {
            reader: Box::new(ConsoleReader),
            writer: Box::new(ConsoleWriter {
                bytes: self.bytes.clone(),
                closes: self.closes.clone(),
            }),
            resizable: false,
        })
    }
}

#[tokio::test]
async fn mixed_files_and_console_keep_independent_sources_after_one_connection_fails() {
    let (ftp, ftp_transport) = source(1, "fixture.ftp");
    let (serial, serial_transport) = source(2, "fixture.serial");
    let files = Arc::new(Files::default());
    let console = Arc::new(Console::default());
    let mut workspace = WorkspaceServices::new(vec![ftp.clone(), serial.clone()]).unwrap();
    workspace.bind_files(&ftp, files.clone()).unwrap();
    workspace.bind_terminal(&serial, console.clone()).unwrap();
    let file_handle = workspace.files.clone().unwrap();
    file_handle.list(Some("opaque@files")).await.unwrap();
    let mut stream = workspace
        .terminal
        .as_ref()
        .unwrap()
        .open(TerminalSize::new(80, 24))
        .await
        .unwrap();
    assert!(!stream.resizable);
    ftp.disconnect().await.unwrap();
    assert!(workspace.is_connected());
    assert!(file_handle
        .list(Some("opaque@files"))
        .await
        .unwrap_err()
        .to_string()
        .contains("fixture.ftp"));
    assert_eq!(files.calls.load(Ordering::SeqCst), 1);
    stream.writer.write(&[1, 2, 255]).await.unwrap();
    assert_eq!(stream.reader.read().await.unwrap(), Some(vec![0, 255, 42]));
    assert_eq!(*console.bytes.lock().unwrap(), vec![1, 2, 255]);
    assert_eq!(serial_transport.closes.load(Ordering::SeqCst), 0);
    workspace.disconnect().await.unwrap();
    assert!(stream.writer.write(&[9]).await.is_err());
    stream.writer.close().await.unwrap();
    assert_eq!(ftp_transport.closes.load(Ordering::SeqCst), 1);
    assert_eq!(serial_transport.closes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn workspace_release_does_not_close_another_workspace_lease_or_keep_stale_handles_alive() {
    let (shared, transport) = source(3, "fixture.shared");
    let files = Arc::new(Files::default());
    let mut first = WorkspaceServices::new(vec![shared.clone(), shared.clone()]).unwrap();
    let mut second = WorkspaceServices::new(vec![shared.clone()]).unwrap();
    first.bind_files(&shared, files.clone()).unwrap();
    second.bind_files(&shared, files).unwrap();
    assert_eq!(first.identities().len(), 1);
    let stale = first.files.clone().unwrap();
    first.disconnect().await.unwrap();
    assert_eq!(transport.closes.load(Ordering::SeqCst), 0);
    assert!(stale.list(Some("opaque@files")).await.is_err());
    second
        .files
        .as_ref()
        .unwrap()
        .list(Some("opaque@files"))
        .await
        .unwrap();
    second.disconnect().await.unwrap();
    assert_eq!(transport.closes.load(Ordering::SeqCst), 1);
    assert!(shared.lease().is_err());
}

#[tokio::test]
async fn delayed_read_cannot_return_after_its_connection_is_disconnected() {
    let (resource, _) = source(4, "fixture.files");
    let files = Arc::new(Files::default());
    files.delay.store(true, Ordering::SeqCst);
    let mut workspace = WorkspaceServices::new(vec![resource.clone()]).unwrap();
    workspace.bind_files(&resource, files.clone()).unwrap();
    let handle = workspace.files.clone().unwrap();
    let task = tokio::spawn(async move { handle.preview("opaque@document").await });
    files.entered.notified().await;
    resource.disconnect().await.unwrap();
    files.release.notify_one();
    assert!(task
        .await
        .unwrap()
        .unwrap_err()
        .to_string()
        .contains("disconnected"));
    workspace.disconnect().await.unwrap();
}

#[tokio::test]
async fn foreign_sources_identity_collisions_and_implicit_rebinding_are_refused() {
    let (a, _) = source(5, "fixture.a");
    let (b, _) = source(6, "fixture.b");
    let (collision, _) = source(5, "fixture.collision");
    let mut workspace = WorkspaceServices::new(vec![a.clone()]).unwrap();
    let files = Arc::new(Files::default());
    assert!(workspace.bind_files(&b, files.clone()).is_err());
    workspace.bind_files(&a, files.clone()).unwrap();
    assert!(workspace.bind_files(&a, files.clone()).is_err());
    assert!(WorkspaceServices::new(vec![a.clone(), collision.clone()]).is_err());
    assert_eq!(files.calls.load(Ordering::SeqCst), 0);
    workspace.disconnect().await.unwrap();
    b.disconnect().await.unwrap();
    collision.disconnect().await.unwrap();
}

#[tokio::test]
async fn late_console_open_is_closed_and_drop_releases_last_workspace_lease() {
    let (resource, transport) = source(7, "fixture.console");
    let console = Arc::new(Console::default());
    console.delay.store(true, Ordering::SeqCst);
    let mut workspace = WorkspaceServices::new(vec![resource.clone()]).unwrap();
    workspace.bind_terminal(&resource, console.clone()).unwrap();
    let terminal = workspace.terminal.clone().unwrap();
    let task = tokio::spawn(async move { terminal.open(TerminalSize::new(80, 24)).await });
    console.entered.notified().await;
    drop(workspace);
    console.release.notify_one();
    assert!(task.await.unwrap().is_err());
    resource.disconnect().await.unwrap();
    assert_eq!(console.closes.load(Ordering::SeqCst), 1);
    assert_eq!(transport.closes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn dispatched_write_after_workspace_close_reports_uncertainty_and_never_retries() {
    struct Text {
        entered: Notify,
        release: Notify,
        writes: AtomicUsize,
    }
    #[async_trait]
    impl TextFileService for Text {
        async fn read_text(&self, _: &str) -> Result<TextDocument> {
            unreachable!()
        }
        async fn create_text(&self, _: &str, _: &str, _: &str) -> Result<TextDocument> {
            unreachable!()
        }
        async fn save_text(&self, path: &str, text: &str, _: &str) -> Result<TextDocument> {
            self.entered.notify_one();
            self.release.notified().await;
            self.writes.fetch_add(1, Ordering::SeqCst);
            Ok(TextDocument {
                path: path.into(),
                name: "item".into(),
                parent: None,
                text: text.into(),
                revision: "new".into(),
                writable: true,
                save_requires_confirmation: false,
            })
        }
    }
    for (replace, confirmed) in [(false, false), (true, false), (false, true), (true, true)] {
        let (resource, _) = source(8, "fixture.files");
        let mut workspace = WorkspaceServices::new(vec![resource.clone()]).unwrap();
        let survivor = WorkspaceServices::new(vec![resource.clone()]).unwrap();
        let text = Arc::new(Text {
            entered: Notify::new(),
            release: Notify::new(),
            writes: AtomicUsize::new(0),
        });
        workspace.bind_text(&resource, text.clone()).unwrap();
        let handle = workspace.text.clone().unwrap();
        let task = tokio::spawn(async move {
            if confirmed {
                handle
                    .save_text_confirmed("opaque@text", "draft", "old", true)
                    .await
            } else {
                handle.save_text("opaque@text", "draft", "old").await
            }
        });
        text.entered.notified().await;
        if replace {
            let (fresh, _) = source(140, "fixture.replacement");
            workspace
                .replace_source(resource.identity(), file_workspace(&fresh))
                .unwrap()
                .close()
                .await
                .unwrap();
            workspace
                .files
                .as_ref()
                .unwrap()
                .list(Some("opaque@files"))
                .await
                .unwrap();
        } else {
            workspace.disconnect().await.unwrap();
        }
        assert!(survivor.is_connected());
        text.release.notify_one();
        let error = task.await.unwrap().err().unwrap().to_string();
        assert!(error.contains("uncertain"));
        assert_eq!(text.writes.load(Ordering::SeqCst), 1);
        survivor.disconnect().await.unwrap();
    }
}

#[tokio::test]
async fn transfer_streams_reject_stale_io_but_allow_cleanup_and_abort_late_open() {
    #[derive(Default)]
    struct Transfers {
        aborts: Arc<AtomicUsize>,
        writes: Arc<AtomicUsize>,
        delay: AtomicBool,
        entered: Notify,
        release: Notify,
    }
    struct DownloadHandle(Arc<AtomicUsize>);
    struct UploadHandle {
        aborts: Arc<AtomicUsize>,
        writes: Arc<AtomicUsize>,
    }
    #[async_trait]
    impl TransferReader for DownloadHandle {
        fn file(&self) -> TransferFile {
            TransferFile {
                location: FileLocation {
                    path: "object@file".into(),
                    name: "file".into(),
                    parent: None,
                },
                size: 1,
            }
        }
        async fn read(&mut self) -> Result<Vec<u8>> {
            Ok(vec![1])
        }
        async fn finish(&mut self) -> Result<()> {
            Ok(())
        }
        async fn abort(&mut self) -> Result<()> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    #[async_trait]
    impl TransferWriter for UploadHandle {
        async fn write(&mut self, _: &[u8]) -> Result<()> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        async fn finish(&mut self) -> Result<FileLocation> {
            unreachable!()
        }
        async fn abort(&mut self) -> Result<()> {
            self.aborts.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    #[async_trait]
    impl FileTransferService for Transfers {
        async fn download(self: Arc<Self>, _: &str, _: &str) -> Result<Box<dyn TransferReader>> {
            Ok(Box::new(DownloadHandle(self.aborts.clone())))
        }
        async fn upload(
            self: Arc<Self>,
            _: &str,
            _: &str,
            _: u64,
        ) -> Result<Box<dyn TransferWriter>> {
            self.entered.notify_one();
            if self.delay.load(Ordering::SeqCst) {
                self.release.notified().await;
            }
            Ok(Box::new(UploadHandle {
                aborts: self.aborts.clone(),
                writes: self.writes.clone(),
            }))
        }
    }
    let transfers = Arc::new(Transfers::default());
    let (resource, _) = source(9, "fixture.files");
    let (other, _) = source(11, "fixture.other-files");
    let mut workspace = WorkspaceServices::new(vec![resource.clone(), other.clone()]).unwrap();
    workspace
        .bind_files(&resource, Arc::new(Files::default()))
        .unwrap();
    assert!(workspace.bind_transfers(&other, transfers.clone()).is_err());
    workspace
        .bind_transfers(&resource, transfers.clone())
        .unwrap();
    let service = workspace.transfers.clone().unwrap();
    let mut upload = service
        .clone()
        .upload("node@root", "file", 1)
        .await
        .unwrap();
    let mut download = service.download("object@file", "revision").await.unwrap();
    workspace.disconnect().await.unwrap();
    assert!(upload.write(&[42]).await.is_err());
    assert!(download.read().await.is_err());
    assert_eq!(transfers.writes.load(Ordering::SeqCst), 0);
    upload.abort().await.unwrap();
    download.abort().await.unwrap();
    assert_eq!(transfers.aborts.load(Ordering::SeqCst), 2);

    let (resource, _) = source(10, "fixture.files");
    let mut workspace = WorkspaceServices::new(vec![resource.clone()]).unwrap();
    workspace
        .bind_transfers(&resource, transfers.clone())
        .unwrap();
    transfers.delay.store(true, Ordering::SeqCst);
    // Consume the notification from the earlier successful upload.
    transfers.entered.notified().await;
    let service = workspace.transfers.clone().unwrap();
    let task = tokio::spawn(async move { service.upload("node@root", "late", 1).await });
    transfers.entered.notified().await;
    workspace.disconnect().await.unwrap();
    transfers.release.notify_one();
    assert!(task.await.unwrap().is_err());
    assert_eq!(transfers.aborts.load(Ordering::SeqCst), 3);
}
