// SPDX-License-Identifier: MPL-2.0
use russh_sftp::{
    client::RawSftpSession,
    protocol::{File, FileAttributes, Handle, Name, Status, StatusCode},
    server::Handler,
};
use shellcanvas_core::{FileSystemProvider, SftpBrowser, SftpTextFiles, DIRECTORY_PAGE};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::Notify;

#[derive(Default)]
struct Observations {
    opens: AtomicUsize,
    reads: AtomicUsize,
    closes: AtomicUsize,
    release: Notify,
}
struct Server {
    observations: Arc<Observations>,
    handles: HashMap<String, (String, usize)>,
}
impl Handler for Server {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, StatusCode> {
        Ok(Name {
            id,
            files: vec![File::dummy(if path == "." {
                "/home/fixture"
            } else {
                &path
            })],
        })
    }
    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, StatusCode> {
        let n = self.observations.opens.fetch_add(1, Ordering::SeqCst);
        let handle = format!("directory-{n}");
        self.handles.insert(handle.clone(), (path.clone(), 0));
        if path == "/openhold" {
            self.observations.release.notified().await;
        }
        Ok(Handle { id, handle })
    }
    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, StatusCode> {
        self.observations.reads.fetch_add(1, Ordering::SeqCst);
        let (path, offset) = self.handles.get_mut(&handle).ok_or(StatusCode::Failure)?;
        if path == "/readhold" {
            self.observations.release.notified().await;
        }
        if path == "/bad" {
            return Ok(Name {
                id,
                files: vec![File::dummy("escape/child")],
            });
        }
        let total = if path == "/small" { 3 } else { 50_000 };
        if *offset == total {
            return Err(StatusCode::Eof);
        }
        let end = (*offset + 17).min(total);
        let files = (*offset..end)
            .map(|index| {
                File::new(
                    format!("item-{index:05}"),
                    FileAttributes {
                        permissions: Some(0o100644),
                        size: Some(index as u64),
                        ..FileAttributes::empty()
                    },
                )
            })
            .collect();
        *offset = end;
        Ok(Name { id, files })
    }
    async fn close(&mut self, id: u32, handle: String) -> Result<Status, StatusCode> {
        let (path, _) = self.handles.remove(&handle).ok_or(StatusCode::Failure)?;
        self.observations.closes.fetch_add(1, Ordering::SeqCst);
        if path == "/closehold" {
            self.observations.release.notified().await;
        }
        if path == "/closefail" {
            return Err(StatusCode::Failure);
        }
        Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: String::new(),
            language_tag: String::new(),
        })
    }
}
async fn fixture() -> (Arc<SftpBrowser>, Arc<Observations>) {
    let (client, server) = tokio::io::duplex(256 * 1024);
    let observations = Arc::new(Observations::default());
    tokio::spawn(russh_sftp::server::run(
        server,
        Server {
            observations: observations.clone(),
            handles: HashMap::new(),
        },
    ));
    let service = SftpTextFiles::new(RawSftpSession::new(client))
        .await
        .unwrap();
    (Arc::new(SftpBrowser(Arc::new(service))), observations)
}
async fn count(value: &AtomicUsize, expected: usize) {
    tokio::time::timeout(Duration::from_secs(4), async {
        while value.load(Ordering::SeqCst) != expected {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn real_sftp_pages_fetch_on_demand_without_a_total_entry_cap() {
    let (browser, observations) = fixture().await;
    let mut scan = browser.clone().open_directory(None).await.unwrap();
    assert_eq!(observations.reads.load(Ordering::SeqCst), 0);
    let first = scan.next().await.unwrap();
    assert_eq!(first.directory.entries.len(), DIRECTORY_PAGE);
    assert_eq!(first.directory.home.as_ref().unwrap().path, "/home/fixture");
    assert_eq!(observations.reads.load(Ordering::SeqCst), 8);
    assert!(!first.done);
    let mut expected = DIRECTORY_PAGE;
    loop {
        let page = scan.next().await.unwrap();
        assert!(page.directory.entries.len() <= DIRECTORY_PAGE);
        for entry in page.directory.entries {
            assert_eq!(entry.path, format!("/home/fixture/item-{expected:05}"));
            assert_eq!(entry.size, expected as u64);
            expected += 1;
        }
        if page.done {
            break;
        }
    }
    assert_eq!(expected, 50_000);
    assert_eq!(observations.closes.load(Ordering::SeqCst), 1);
    assert!(scan.next().await.is_err());
    scan.close().await.unwrap();
    assert_eq!(browser.list(Some("/small")).await.unwrap().entries.len(), 3);
    assert_eq!(observations.closes.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn canceled_open_closes_its_late_handle_without_retiring_the_channel() {
    let (browser, observations) = fixture().await;
    let pending = {
        let browser = browser.clone();
        tokio::spawn(async move { browser.open_directory(Some("/openhold")).await })
    };
    count(&observations.opens, 1).await;
    pending.abort();
    assert!(matches!(pending.await, Err(error) if error.is_cancelled()));
    observations.release.notify_one();
    count(&observations.closes, 1).await;
    assert_eq!(browser.list(Some("/small")).await.unwrap().entries.len(), 3);
}

#[tokio::test]
async fn canceled_page_cannot_be_retried_and_drop_releases_only_its_handle() {
    let (browser, observations) = fixture().await;
    let mut paused = browser
        .clone()
        .open_directory(Some("/readhold"))
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), paused.next())
            .await
            .is_err()
    );
    count(&observations.reads, 1).await;
    assert!(paused.next().await.is_err());
    observations.release.notify_one();
    drop(paused);
    count(&observations.closes, 1).await;
    let mut first = browser.clone().open_directory(None).await.unwrap();
    let mut second = browser.open_directory(Some("/small")).await.unwrap();
    first.next().await.unwrap();
    drop(first);
    count(&observations.closes, 2).await;
    let page = second.next().await.unwrap();
    assert!(page.done);
    assert_eq!(page.directory.entries.len(), 3);
}

#[tokio::test]
async fn invalid_server_entries_retire_the_reader_and_confirm_cleanup() {
    let (browser, observations) = fixture().await;
    let mut bad = browser.clone().open_directory(Some("/bad")).await.unwrap();
    assert!(bad.next().await.is_err());
    assert!(bad.next().await.is_err());
    assert_eq!(observations.closes.load(Ordering::SeqCst), 1);
    assert_eq!(browser.list(Some("/small")).await.unwrap().entries.len(), 3);
}
#[tokio::test]
async fn close_keeps_its_outcome_after_a_canceled_waiter_and_never_retries() {
    let (browser, observations) = fixture().await;
    let mut paused = browser
        .clone()
        .open_directory(Some("/closehold"))
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), paused.close())
            .await
            .is_err()
    );
    count(&observations.closes, 1).await;
    observations.release.notify_one();
    paused.close().await.unwrap();
    paused.close().await.unwrap();
    assert_eq!(observations.closes.load(Ordering::SeqCst), 1);
    let mut failed = browser.open_directory(Some("/closefail")).await.unwrap();
    assert!(failed.close().await.is_err());
    assert!(failed.close().await.is_err());
    assert_eq!(observations.closes.load(Ordering::SeqCst), 2);
}
