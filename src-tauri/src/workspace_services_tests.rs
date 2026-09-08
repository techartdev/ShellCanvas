// SPDX-License-Identifier: MPL-2.0
use super::*;
use std::sync::{atomic::AtomicUsize, Mutex};
use tokio::sync::Notify;

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
#[derive(Default)]
struct Files {
    calls: AtomicUsize,
    delay: AtomicBool,
    entered: Notify,
    release: Notify,
}
#[async_trait]
impl FileSystemProvider for Files {
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
            })
        }
    }
    let (source, _) = source(8, "fixture.files");
    let mut workspace = WorkspaceServices::new(vec![source.clone()]).unwrap();
    let survivor = WorkspaceServices::new(vec![source.clone()]).unwrap();
    let text = Arc::new(Text {
        entered: Notify::new(),
        release: Notify::new(),
        writes: AtomicUsize::new(0),
    });
    workspace.bind_text(&source, text.clone()).unwrap();
    let handle = workspace.text.clone().unwrap();
    let task = tokio::spawn(async move { handle.save_text("opaque@text", "draft", "old").await });
    text.entered.notified().await;
    workspace.disconnect().await.unwrap();
    assert!(survivor.is_connected());
    text.release.notify_one();
    let error = task.await.unwrap().err().unwrap().to_string();
    assert!(error.contains("uncertain"));
    assert_eq!(text.writes.load(Ordering::SeqCst), 1);
    survivor.disconnect().await.unwrap();
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
