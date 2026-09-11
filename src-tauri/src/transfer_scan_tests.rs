// SPDX-License-Identifier: MPL-2.0
use super::*;
use async_trait::async_trait;
use shellcanvas_core::{TransferDirectory, TransferReader, TransferWriter};
use std::sync::atomic::{AtomicUsize, Ordering};
struct Paged {
    width: usize,
    depth: usize,
    opens: AtomicUsize,
    active: AtomicUsize,
    peak: AtomicUsize,
    pages: AtomicUsize,
    aborted: AtomicUsize,
    stall: bool,
    /// Extra bytes in each opaque file path, to grow metadata without files.
    padding: usize,
}
impl Paged {
    fn new(width: usize, depth: usize, stall: bool) -> Arc<Self> {
        Self::padded(width, depth, stall, 0)
    }
    fn padded(width: usize, depth: usize, stall: bool, padding: usize) -> Arc<Self> {
        Arc::new(Self {
            width,
            depth,
            opens: 0.into(),
            active: 0.into(),
            peak: 0.into(),
            pages: 0.into(),
            aborted: 0.into(),
            stall,
            padding,
        })
    }
}
fn entry(path: String, name: String, directory: bool) -> FileEntry {
    FileEntry {
        path,
        name,
        kind: if directory { "directory" } else { "file" }.into(),
        size: if directory { 0 } else { 1 },
        modified: None,
        revision: "revision".into(),
    }
}
struct Cursor {
    owner: Arc<Paged>,
    depth: usize,
    offset: usize,
    closed: bool,
}
impl Cursor {
    fn close(&mut self) {
        if !self.closed {
            self.closed = true;
            self.owner.active.fetch_sub(1, Ordering::SeqCst);
        }
    }
}
impl Drop for Cursor {
    fn drop(&mut self) {
        self.close();
    }
}
#[async_trait]
impl TransferDirectory for Cursor {
    async fn next(&mut self) -> Result<Vec<FileEntry>> {
        self.owner.pages.fetch_add(1, Ordering::SeqCst);
        if self.owner.stall {
            std::future::pending::<()>().await;
        }
        if self.owner.depth > 0 {
            if self.offset == 0 && self.depth < self.owner.depth {
                self.offset = 1;
                return Ok(vec![entry(
                    format!("directory@{}", self.depth + 1),
                    "d".into(),
                    true,
                )]);
            }
            return Ok(Vec::new());
        }
        let end = (self.offset + TRANSFER_DIRECTORY_PAGE).min(self.owner.width);
        let padding = "x".repeat(self.owner.padding);
        let entries = (self.offset..end)
            .map(|i| entry(format!("file@{i}{padding}"), format!("file-{i}.bin"), false))
            .collect();
        self.offset = end;
        Ok(entries)
    }
    async fn finish(&mut self) -> Result<()> {
        self.close();
        Ok(())
    }
    async fn abort(&mut self) -> Result<()> {
        self.owner.aborted.fetch_add(1, Ordering::SeqCst);
        self.close();
        Ok(())
    }
}
#[async_trait]
impl FileTransferService for Paged {
    fn supports_folders(&self) -> bool {
        true
    }
    async fn transfer_directory(
        self: Arc<Self>,
        path: &str,
        _: &str,
    ) -> Result<Box<dyn TransferDirectory>> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(active, Ordering::SeqCst);
        let depth = path.strip_prefix("directory@").unwrap().parse()?;
        Ok(Box::new(Cursor {
            owner: self,
            depth,
            offset: 0,
            closed: false,
        }))
    }
    async fn download(self: Arc<Self>, _: &str, _: &str) -> Result<Box<dyn TransferReader>> {
        bail!("Discovery must not open file contents")
    }
    async fn upload(self: Arc<Self>, _: &str, _: &str, _: u64) -> Result<Box<dyn TransferWriter>> {
        bail!("Discovery must not create destination files")
    }
}
#[tokio::test]
async fn fifty_thousand_entries_use_one_cursor_and_a_disposable_disk_catalog() {
    let paged = Paged::new(50_000, 0, false);
    let service: Arc<dyn FileTransferService> = paged.clone();
    let plan = remote(&service, entry("directory@0".into(), "Root".into(), true))
        .await
        .unwrap();
    assert_eq!(
        paged.opens.load(Ordering::SeqCst),
        0,
        "Preparation must return before discovery"
    );
    let (_stop, cancel) = watch::channel(false);
    let mut discovered = 0;
    let catalog = scan(plan, service, true, &cancel, &mut |event| {
        assert_eq!(event.phase, "preparing");
        assert!(event.items.unwrap() >= discovered);
        discovered = event.items.unwrap();
    })
    .await
    .unwrap();
    assert_eq!(catalog.len(), 50_001);
    assert_eq!(catalog.size(), 50_000);
    assert_eq!(paged.peak.load(Ordering::SeqCst), 1);
    assert_eq!(paged.active.load(Ordering::SeqCst), 0);
    assert!(paged.pages.load(Ordering::SeqCst) > 390);
    assert_eq!(catalog.get(50_001).unwrap().entry.name, "file-49999.bin");
    let path = catalog.scratch_path().to_path_buf();
    assert!(path.join("catalog.sqlite").metadata().unwrap().len() > 2 * 1024 * 1024);
    drop(catalog);
    assert!(!path.exists());
}
#[tokio::test]
async fn deep_provider_tree_has_no_64_level_cap_or_recursive_stack() {
    let paged = Paged::new(0, 512, false);
    let service: Arc<dyn FileTransferService> = paged.clone();
    let plan = remote(&service, entry("directory@0".into(), "Root".into(), true))
        .await
        .unwrap();
    let (_stop, cancel) = watch::channel(false);
    let catalog = scan(plan, service, false, &cancel, &mut |_| {})
        .await
        .unwrap();
    assert_eq!(catalog.len(), 513);
    assert_eq!(paged.peak.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn scan_cancel_closes_a_stalled_cursor_without_destination_writes() {
    let paged = Paged::new(100_000, 0, true);
    let service: Arc<dyn FileTransferService> = paged.clone();
    let plan = remote(&service, entry("directory@0".into(), "Root".into(), true))
        .await
        .unwrap();
    let (stop, cancel) = watch::channel(false);
    let trigger = async {
        while paged.active.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        stop.send_replace(true);
    };
    let work = async { scan(plan, service, true, &cancel, &mut |_| {}).await };
    let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        tokio::join!(work, trigger)
    })
    .await
    .unwrap();
    assert!(result.err().unwrap().to_string().contains("canceled"));
    assert_eq!(paged.active.load(Ordering::SeqCst), 0);
    assert_eq!(paged.aborted.load(Ordering::SeqCst), 1);
}
fn root() -> FileEntry {
    entry("directory@0".into(), "Root".into(), true)
}
fn seeded(catalog: Catalog) -> Arc<Catalog> {
    catalog.add(None, vec![(root(), None)]).unwrap();
    Arc::new(catalog)
}
fn progress() -> Progress {
    Progress {
        bytes: 0,
        total: 0,
        items: None,
        phase: "preparing",
    }
}
/// The 0.1.0 catalog refused discovery beyond 250,000 entries. Traversal is
/// incremental: one cursor, one page in memory, metadata on disk.
#[tokio::test]
async fn discovery_exceeds_the_former_item_budget_with_one_cursor() {
    const FILES: usize = 250_127;
    let paged = Paged::new(FILES, 0, false);
    let service: Arc<dyn FileTransferService> = paged.clone();
    let catalog = seeded(Catalog::new(false).unwrap());
    let scratch = catalog.scratch_path().to_path_buf();
    let (_stop, cancel) = watch::channel(false);
    let mut largest_step = 0;
    let mut seen = 1;
    let catalog = scan_catalog(catalog, service, &cancel, &mut |event| {
        let items = event.items.unwrap();
        largest_step = largest_step.max(items - seen);
        seen = items;
    })
    .await
    .unwrap();
    assert_eq!(catalog.len(), FILES as u64 + 1);
    assert!(catalog.len() > 250_000);
    assert_eq!(catalog.size(), FILES as u64);
    assert_eq!(
        catalog.get(catalog.len()).unwrap().entry.name,
        "file-250126.bin"
    );
    assert_eq!(paged.opens.load(Ordering::SeqCst), 1);
    assert_eq!(paged.peak.load(Ordering::SeqCst), 1);
    assert_eq!(paged.active.load(Ordering::SeqCst), 0);
    assert!(
        largest_step <= TRANSFER_DIRECTORY_PAGE as u64,
        "one page at a time"
    );
    drop(catalog);
    assert!(!scratch.exists());
}
#[tokio::test]
async fn cancellation_in_large_discovery_is_reported_as_canceled_and_releases_everything() {
    let paged = Paged::new(1_000_000, 0, false);
    let service: Arc<dyn FileTransferService> = paged.clone();
    let catalog = seeded(Catalog::new(false).unwrap());
    let scratch = catalog.scratch_path().to_path_buf();
    let (stop, cancel) = watch::channel(false);
    let error = scan_catalog(catalog.clone(), service, &cancel, &mut |event| {
        if event.items.unwrap() > 20_000 {
            stop.send_replace(true);
        }
    })
    .await
    .err()
    .unwrap();
    let discovered = catalog.len();
    assert!((20_000..30_000).contains(&discovered), "{discovered}");
    let result = outcome(Err(error), &progress());
    assert_eq!(result.status, "canceled", "{:?}", result.message);
    assert_eq!(paged.aborted.load(Ordering::SeqCst), 1);
    assert_eq!(paged.active.load(Ordering::SeqCst), 0);
    drop(catalog);
    assert!(
        !scratch.exists(),
        "canceled discovery must remove its scratch catalog"
    );
}
#[tokio::test]
async fn full_scratch_disk_fails_clearly_and_is_never_reported_as_canceled() {
    let paged = Paged::new(1_000_000, 0, false);
    let service: Arc<dyn FileTransferService> = paged.clone();
    let catalog = seeded(Catalog::with_page_limit(false, 256).unwrap());
    let scratch = catalog.scratch_path().to_path_buf();
    let (_stop, cancel) = watch::channel(false);
    let error = scan_catalog(catalog.clone(), service, &cancel, &mut |_| {})
        .await
        .err()
        .unwrap();
    let result = outcome(Err(error), &progress());
    assert_eq!(result.status, "failed");
    let message = result.message.unwrap();
    assert!(
        message.starts_with(crate::transfers::catalog::STORAGE_FULL),
        "{message}"
    );
    assert!(!message.contains("Duplicate"), "{message}");
    assert_eq!(
        paged.aborted.load(Ordering::SeqCst),
        1,
        "cursor must be released"
    );
    assert_eq!(paged.active.load(Ordering::SeqCst), 0);
    assert!(
        catalog.len() > 1,
        "discovery ran until storage was exhausted"
    );
    drop(catalog);
    assert!(!scratch.exists());
}
/// Only in-memory consumers such as Explorer offers pass a limit; it stops early.
#[tokio::test]
async fn in_memory_consumer_limit_stops_discovery_early_with_its_own_message() {
    let paged = Paged::new(1_000_000, 0, false);
    let service: Arc<dyn FileTransferService> = paged.clone();
    let (_stop, cancel) = watch::channel(false);
    let error = scan_catalog_limited(
        seeded(Catalog::new(true).unwrap()),
        service,
        &cancel,
        &mut |_| {},
        Some((1_000, "Explorer limit fixture")),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(error.to_string(), "Explorer limit fixture");
    assert!(paged.pages.load(Ordering::SeqCst) <= 1_000 / TRANSFER_DIRECTORY_PAGE + 1);
    assert_eq!(paged.aborted.load(Ordering::SeqCst), 1);
    assert_eq!(paged.active.load(Ordering::SeqCst), 0);
    assert_eq!(outcome(Err(error), &progress()).status, "failed");
}
/// Partial cancellation after destinations changed is checked with a real result
/// in `chooser_download_preflights_all_roots_and_preserves_completed_items_on_cancel`.
#[test]
fn outcome_reports_completion_with_the_published_path() {
    let result = outcome(Ok(("published@opaque".into(), None)), &progress());
    assert_eq!(result.status, "completed");
    assert_eq!(result.path.as_deref(), Some("published@opaque"));
}
/// Former 128 MiB metadata budget, exceeded with 32 KiB opaque paths in pages no
/// larger than one adapter frame. Writes about 0.5 GB of scratch data, so it is
/// opt-in: set TMP/TEMP to a volume with space, then run with --ignored.
#[tokio::test]
#[ignore = "writes ~0.5 GB of scratch metadata; run explicitly with TMP on a spacious volume"]
async fn discovery_exceeds_the_former_metadata_budget() {
    const FILES: usize = 5_000;
    let paged = Paged::padded(FILES, 0, false, 32 * 1024);
    let service: Arc<dyn FileTransferService> = paged.clone();
    let catalog = seeded(Catalog::new(false).unwrap());
    let scratch = catalog.scratch_path().to_path_buf();
    let (_stop, cancel) = watch::channel(false);
    let catalog = scan_catalog(catalog, service, &cancel, &mut |_| {})
        .await
        .unwrap();
    assert_eq!(catalog.len(), FILES as u64 + 1);
    let database = scratch.join("catalog.sqlite").metadata().unwrap().len();
    assert!(database > 128 * 1024 * 1024, "{database}");
    assert_eq!(paged.peak.load(Ordering::SeqCst), 1);
    drop(catalog);
    assert!(!scratch.exists());
}
#[tokio::test]
async fn local_scan_exceeds_old_limit_and_changed_file_is_rejected_at_open() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("Many files");
    std::fs::create_dir(&root).unwrap();
    for i in 0..2_500 {
        std::fs::write(root.join(format!("{i}.txt")), b"original").unwrap();
    }
    let plan = local(root.clone()).unwrap();
    let service: Arc<dyn FileTransferService> = Paged::new(0, 0, false);
    let (_stop, cancel) = watch::channel(false);
    let catalog = scan(plan, service, false, &cancel, &mut |_| {})
        .await
        .unwrap();
    assert_eq!(catalog.len(), 2_501);
    let node = catalog.get(2).unwrap();
    // No retained file handle: Windows permits removal and replacement here.
    std::fs::remove_file(&node.entry.path).unwrap();
    std::fs::write(&node.entry.path, b"replacement with a different size").unwrap();
    assert!(open_local(&node).is_err());
}
