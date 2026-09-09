// SPDX-License-Identifier: MPL-2.0
use super::*;
use anyhow::{bail, Result};
use async_trait::async_trait;
use shellcanvas_services::{ConnectionLifecycle, Directory, FileEntry, FileLocation};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::Notify;

struct Live(AtomicBool);
#[async_trait]
impl ConnectionLifecycle for Live {
    fn is_connected(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    async fn disconnect(&self) -> Result<()> {
        self.0.store(false, Ordering::SeqCst);
        Ok(())
    }
}
fn source() -> (Arc<ConnectionResource>, Arc<Live>) {
    let live = Arc::new(Live(AtomicBool::new(true)));
    (
        ConnectionResource::new(
            ConnectionIdentity {
                instance: 1,
                generation: 1,
                adapter: "fixture.reader".into(),
            },
            live.clone(),
        ),
        live,
    )
}
#[derive(Default)]
struct Files {
    opens: AtomicUsize,
    reads: AtomicUsize,
    closes: AtomicUsize,
    delay_open: AtomicBool,
    delay_read: AtomicBool,
    fail_close: AtomicBool,
    panic_read: AtomicBool,
    opened: Notify,
    reading: Notify,
    release_open: Notify,
    release_read: Notify,
}
#[async_trait]
impl FileSystemProvider for Files {
    async fn list(&self, _: Option<&str>) -> Result<Directory> {
        panic!("native reader must not materialize a listing")
    }
    async fn locate(&self, _: &str) -> Result<FileLocation> {
        bail!("unused")
    }
    async fn preview(&self, _: &str) -> Result<String> {
        bail!("unused")
    }
    async fn open_directory(self: Arc<Self>, _: Option<&str>) -> Result<Box<dyn DirectoryReader>> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        self.opened.notify_one();
        if self.delay_open.load(Ordering::SeqCst) {
            self.release_open.notified().await;
        }
        Ok(Box::new(Reader {
            files: self,
            offset: 0,
            closed: false,
        }))
    }
}
struct Reader {
    files: Arc<Files>,
    offset: usize,
    closed: bool,
}
impl Reader {
    fn retire(&mut self) {
        if !self.closed {
            self.closed = true;
            self.files.closes.fetch_add(1, Ordering::SeqCst);
        }
    }
}
impl Drop for Reader {
    fn drop(&mut self) {
        self.retire();
    }
}
#[async_trait]
impl DirectoryReader for Reader {
    async fn next(&mut self) -> Result<DirectoryPage> {
        self.files.reads.fetch_add(1, Ordering::SeqCst);
        self.files.reading.notify_one();
        assert!(
            !self.files.panic_read.load(Ordering::SeqCst),
            "fixture panic"
        );
        if self.files.delay_read.load(Ordering::SeqCst) {
            self.files.release_read.notified().await;
        }
        let entry = FileEntry {
            name: format!("entry-{}", self.offset),
            path: format!("opaque:{}", self.offset),
            kind: "file".into(),
            size: 0,
            modified: None,
            revision: "r1".into(),
        };
        self.offset += 1;
        Ok(DirectoryPage {
            directory: Directory {
                path: "opaque:root".into(),
                name: "Root".into(),
                parent: None,
                home: None,
                roots: vec![],
                entries: vec![entry],
            },
            done: self.offset == 3,
        })
    }
    async fn close(&mut self) -> Result<()> {
        self.retire();
        if self.files.fail_close.load(Ordering::SeqCst) {
            bail!("fixture cleanup failed");
        }
        Ok(())
    }
}
fn control(registry: &DirectoryReaders, id: &str) -> Arc<Control> {
    registry.lookup("main", 10, id).unwrap().unwrap().0
}
async fn released(registry: &DirectoryReaders, expected: usize) {
    tokio::time::timeout(Duration::from_secs(4), async {
        while registry.0.slots.available_permits() != expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn readers_are_lazy_owned_sequential_and_release_after_eof() {
    let registry = DirectoryReaders::default();
    let (source, _) = source();
    let files = Arc::new(Files::default());
    let id = registry
        .begin("main", 10, &source, files.clone(), None)
        .unwrap();
    assert_eq!(files.opens.load(Ordering::SeqCst), 0);
    assert!(registry.lookup("other", 10, &id).is_err());
    assert!(registry.lookup("main", 11, &id).is_err());
    let first = control(&registry, &id);
    assert_eq!(
        first.next().await.unwrap().directory.entries[0].path,
        "opaque:0"
    );
    assert_eq!(files.reads.load(Ordering::SeqCst), 1);
    let second_id = registry
        .begin("main", 10, &source, files.clone(), None)
        .unwrap();
    let second = control(&registry, &second_id);
    assert_eq!(
        second.next().await.unwrap().directory.entries[0].path,
        "opaque:0"
    );
    assert!(!first.next().await.unwrap().done);
    assert!(first.next().await.unwrap().done);
    first.close().await.unwrap();
    assert!(first.next().await.is_err());
    assert_eq!(
        second.next().await.unwrap().directory.entries[0].path,
        "opaque:1"
    );
    second.close().await.unwrap();
    released(&registry, CAPACITY).await;
    assert_eq!(files.closes.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn canceled_open_keeps_capacity_until_late_reader_is_closed() {
    let registry = DirectoryReaders::default();
    let (source, _) = source();
    let files = Arc::new(Files::default());
    files.delay_open.store(true, Ordering::SeqCst);
    let id = registry
        .begin("main", 10, &source, files.clone(), None)
        .unwrap();
    let first = control(&registry, &id);
    let reading = {
        let first = first.clone();
        tokio::spawn(async move { first.next().await })
    };
    files.opened.notified().await;
    first.cancel();
    let closing = {
        let first = first.clone();
        tokio::spawn(async move { first.close().await })
    };
    closing.abort();
    assert_eq!(registry.0.slots.available_permits(), CAPACITY - 1);
    files.release_open.notify_one();
    assert!(reading.await.unwrap().is_err());
    first.close().await.unwrap();
    released(&registry, CAPACITY).await;
    assert_eq!(files.reads.load(Ordering::SeqCst), 0);
    assert_eq!(files.closes.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn closing_the_source_interrupts_a_page_and_preserves_other_sources() {
    let registry = DirectoryReaders::default();
    let (source, _) = source();
    let files = Arc::new(Files::default());
    files.delay_read.store(true, Ordering::SeqCst);
    let id = registry
        .begin("main", 10, &source, files.clone(), None)
        .unwrap();
    let first = control(&registry, &id);
    let reading = {
        let first = first.clone();
        tokio::spawn(async move { first.next().await })
    };
    files.reading.notified().await;
    assert!(first.next().await.unwrap_err().contains("already"));
    registry.close_owner("foreign");
    registry.close_session(11);
    assert!(!*first.canceled.borrow());
    registry.close_source(10, source.identity());
    assert!(reading.await.unwrap().is_err());
    first.close().await.unwrap();
    released(&registry, CAPACITY).await;
    assert_eq!(files.closes.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn failed_cleanup_retains_capacity_until_the_physical_source_is_disconnected() {
    let registry = DirectoryReaders::default();
    let (source, live) = source();
    let files = Arc::new(Files::default());
    files.fail_close.store(true, Ordering::SeqCst);
    for _ in 0..CAPACITY {
        let id = registry
            .begin("main", 10, &source, files.clone(), None)
            .unwrap();
        let first = control(&registry, &id);
        first.next().await.unwrap();
        assert!(first.close().await.is_err());
        assert!(first.close().await.is_err());
    }
    assert_eq!(files.closes.load(Ordering::SeqCst), CAPACITY);
    assert!(registry
        .begin("main", 10, &source, files.clone(), None)
        .is_err());
    registry.close_owner("main");
    registry.close_session(10);
    assert!(registry
        .begin("main", 10, &source, files.clone(), None)
        .is_err());
    live.0.store(false, Ordering::SeqCst);
    let (fresh, _) = self::source();
    let id = registry
        .begin("main", 10, &fresh, files.clone(), None)
        .unwrap();
    control(&registry, &id).close().await.unwrap();
    released(&registry, CAPACITY).await;
}
#[tokio::test]
async fn owner_disposal_and_worker_panics_do_not_leave_waiters_hanging() {
    let registry = DirectoryReaders::default();
    let (source, _) = source();
    let files = Arc::new(Files::default());
    let id = registry
        .begin("main", 10, &source, files.clone(), None)
        .unwrap();
    let first = control(&registry, &id);
    registry.close_owner("main");
    first.close().await.unwrap();
    files.panic_read.store(true, Ordering::SeqCst);
    let id = registry
        .begin("main", 10, &source, files.clone(), None)
        .unwrap();
    let first = control(&registry, &id);
    assert!(first.next().await.is_err());
    assert!(tokio::time::timeout(Duration::from_secs(4), first.close())
        .await
        .unwrap()
        .is_err());
    assert_eq!(registry.0.slots.available_permits(), CAPACITY - 1);
}
