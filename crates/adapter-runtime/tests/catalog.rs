// SPDX-License-Identifier: MPL-2.0
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use shellcanvas_adapter_runtime::catalog::Catalog;
use std::{
    fs,
    path::Path,
    sync::{atomic::AtomicBool, Arc, Barrier},
    time::Duration,
};
use tempfile::TempDir;
fn source() -> (TempDir, Value) {
    let directory = tempfile::tempdir().unwrap();
    let executable = format!("bin/fixture-adapter{}", std::env::consts::EXE_SUFFIX);
    let bytes = fs::read(env!("CARGO_BIN_EXE_fixture-adapter")).unwrap();
    fs::create_dir(directory.path().join("bin")).unwrap();
    fs::write(directory.path().join(&executable), &bytes).unwrap();
    let manifest = json!({"schemaVersion":1,"id":"dev.shellcanvas.fixture","name":"Fixture device","version":"1.0.0","description":"Synthetic adapter","platform":format!("{}-{}",std::env::consts::OS,std::env::consts::ARCH),"entrypoint":executable,"files":[{"path":executable,"size":bytes.len(),"sha256":format!("{:x}",Sha256::digest(&bytes)),"executable":true}],"configuration":[{"id":"standard","label":"Mode","kind":"text","default":"both"},{"id":"token","label":"Token","kind":"password"}]});
    write_manifest(directory.path(), &manifest);
    (directory, manifest)
}
fn write_manifest(root: &Path, manifest: &Value) {
    fs::write(
        root.join("adapter.json"),
        serde_json::to_vec(manifest).unwrap(),
    )
    .unwrap();
}
fn review(catalog: &Catalog, source: &TempDir) -> shellcanvas_adapter_runtime::catalog::Review {
    catalog
        .review(&source.path().join("adapter.json"), &AtomicBool::new(false))
        .unwrap()
}
#[tokio::test]
async fn reviewed_snapshot_runs_after_source_changes_and_old_generation_survives_update_removal() {
    let root = tempfile::tempdir().unwrap();
    let catalog = Catalog::new(root.path().to_path_buf());
    let (source, mut manifest) = source();
    let reviewed = review(&catalog, &source);
    fs::write(
        source.path().join(manifest["entrypoint"].as_str().unwrap()),
        b"changed after review",
    )
    .unwrap();
    let first = catalog.install(reviewed).unwrap();
    let lease = catalog.acquire(&first.id, &first.revision).unwrap();
    let configuration = lease
        .configuration(&json!({"token":"ephemeral-secret"}))
        .unwrap();
    let executable = lease.launch().executable;
    let diagnostics = shellcanvas_adapter_runtime::Diagnostics::default();
    let process = lease
        .connect_observed(&configuration, Duration::from_secs(4), diagnostics.clone())
        .await
        .unwrap();
    assert!(process.files().is_some());
    let bytes = fs::read(env!("CARGO_BIN_EXE_fixture-adapter")).unwrap();
    fs::write(
        source.path().join(manifest["entrypoint"].as_str().unwrap()),
        bytes,
    )
    .unwrap();
    manifest["version"] = json!("2.0.0");
    write_manifest(source.path(), &manifest);
    let second = catalog.install(review(&catalog, &source)).unwrap();
    assert_ne!(first.generation, second.generation);
    assert!(catalog.acquire(&first.id, &first.revision).is_err());
    assert_eq!(catalog.collect().unwrap(), 0);
    catalog.remove(&second.id, &second.revision).unwrap();
    assert_eq!(catalog.collect().unwrap(), 1); // The unused new generation, never the live old one.
    assert_eq!(
        process
            .call(
                "acme.echo",
                json!("old version still works"),
                Duration::from_secs(4)
            )
            .await
            .unwrap(),
        "old version still works"
    );
    assert!(!fs::read_to_string(root.path().join("catalog.json"))
        .unwrap()
        .contains("ephemeral-secret"));
    process.close().await.unwrap();
    assert_eq!(catalog.collect().unwrap(), 1);
    assert!(!executable.exists());
    assert!(!diagnostics.snapshot().events.is_empty()); // History does not retain assets.
}
#[test]
fn disabled_and_changed_packages_cannot_be_launched_and_stale_decisions_are_refused() {
    let root = tempfile::tempdir().unwrap();
    let catalog = Catalog::new(root.path().to_path_buf());
    let (source, _) = source();
    let first = catalog.install(review(&catalog, &source)).unwrap();
    let stale = review(&catalog, &source);
    let disabled = catalog
        .set_enabled(&first.id, &first.revision, false)
        .unwrap();
    assert!(catalog.install(stale).is_err());
    assert!(catalog.acquire(&disabled.id, &disabled.revision).is_err());
    assert!(catalog.remove(&first.id, &first.revision).is_err());
    let disabled = catalog.install(review(&catalog, &source)).unwrap();
    assert!(!disabled.enabled);
    let enabled = catalog
        .set_enabled(&disabled.id, &disabled.revision, true)
        .unwrap();
    let lease = catalog.acquire(&enabled.id, &enabled.revision).unwrap();
    let executable = lease.launch().executable;
    drop(lease);
    fs::write(executable, b"modified installed bytes").unwrap();
    assert!(catalog.acquire(&enabled.id, &enabled.revision).is_err());
}
#[test]
fn competing_installations_use_catalog_revisions_and_keep_one_complete_generation() {
    let root = tempfile::tempdir().unwrap();
    let catalog = Catalog::new(root.path().to_path_buf());
    let (source, _) = source();
    let reviews = [review(&catalog, &source), review(&catalog, &source)];
    let barrier = Arc::new(Barrier::new(2));
    let threads: Vec<_> = reviews
        .into_iter()
        .map(|review| {
            let catalog = catalog.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                catalog.install(review)
            })
        })
        .collect();
    let results: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(catalog.list().unwrap().len(), 1);
    let info = catalog.list().unwrap().remove(0);
    assert!(catalog.acquire(&info.id, &info.revision).is_ok());
}
#[test]
fn cancellation_and_invalid_asset_paths_leave_no_installed_package() {
    let root = tempfile::tempdir().unwrap();
    let catalog = Catalog::new(root.path().to_path_buf());
    let (source, mut manifest) = source();
    assert!(catalog
        .review(&source.path().join("adapter.json"), &AtomicBool::new(true))
        .is_err());
    for path in [
        "../escape.exe",
        "/absolute.exe",
        "C:/absolute.exe",
        "bin/CON.exe",
        "bin/CON .exe",
        "bin/COM¹.exe",
        "bin/CONOUT$",
        "bin/trailing. ",
        "bin\\other.exe",
    ] {
        manifest["entrypoint"] = json!(path);
        manifest["files"][0]["path"] = json!(path);
        write_manifest(source.path(), &manifest);
        assert!(catalog
            .review(&source.path().join("adapter.json"), &AtomicBool::new(false))
            .is_err());
    }
    assert!(catalog.list().unwrap().is_empty());
    assert_eq!(
        fs::read_dir(root.path().join("staging")).unwrap().count(),
        0
    );
}
#[test]
fn manifest_hashes_duplicate_paths_and_typed_configuration_are_enforced() {
    let root = tempfile::tempdir().unwrap();
    let catalog = Catalog::new(root.path().to_path_buf());
    let (source, manifest) = source();
    let mut bad = manifest.clone();
    bad["files"][0]["sha256"] = json!("0".repeat(64));
    write_manifest(source.path(), &bad);
    assert!(catalog
        .review(&source.path().join("adapter.json"), &AtomicBool::new(false))
        .is_err());
    bad = manifest.clone();
    let mut duplicate = bad["files"][0].clone();
    duplicate["path"] = json!(duplicate["path"].as_str().unwrap().to_uppercase());
    bad["files"].as_array_mut().unwrap().push(duplicate);
    write_manifest(source.path(), &bad);
    assert!(catalog
        .review(&source.path().join("adapter.json"), &AtomicBool::new(false))
        .is_err());
    bad = manifest.clone();
    bad["configuration"][1]["default"] = json!("must never be packaged");
    write_manifest(source.path(), &bad);
    assert!(catalog
        .review(&source.path().join("adapter.json"), &AtomicBool::new(false))
        .is_err());
    write_manifest(source.path(), &manifest);
    let info = catalog.install(review(&catalog, &source)).unwrap();
    let lease = catalog.acquire(&info.id, &info.revision).unwrap();
    assert_eq!(
        lease.configuration(&json!({})).unwrap(),
        json!({"standard":"both"})
    );
    assert!(lease.configuration(&json!({"standard":true})).is_err());
    assert!(lease.configuration(&json!({"unknown":1})).is_err());
}
#[test]
fn foreign_reviews_and_corrupt_or_future_catalogs_are_not_overwritten() {
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let catalog = Catalog::new(root.path().to_path_buf());
    let foreign = Catalog::new(other.path().to_path_buf());
    let (source, _) = source();
    assert!(foreign.install(review(&catalog, &source)).is_err());
    for contents in ["broken JSON", "{\"version\":2,\"records\":[]}"] {
        fs::write(root.path().join("catalog.json"), contents).unwrap();
        assert!(catalog
            .review(&source.path().join("adapter.json"), &AtomicBool::new(false))
            .is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("catalog.json")).unwrap(),
            contents
        );
    }
}

async fn holding_review(root: &Path, source: &Path) -> tokio::process::Child {
    use tokio::io::AsyncBufReadExt;
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_catalog-review-fixture"));
    command
        .args([root, source])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().unwrap();
    let mut output = tokio::io::BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(10), output.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(line.trim(), "ready");
    child
}

#[tokio::test]
async fn crash_recovery_preserves_other_process_reviews_and_live_generations() {
    let root = tempfile::tempdir().unwrap();
    let catalog = Catalog::new(root.path().to_owned());
    let (source, _) = source();
    let manifest = source.path().join("adapter.json");
    let mut crashed = holding_review(root.path(), &manifest).await;
    let mut surviving = holding_review(root.path(), &manifest).await;
    let local_review = review(&catalog, &source);
    let installed = catalog.install(review(&catalog, &source)).unwrap();
    let process = catalog
        .acquire(&installed.id, &installed.revision)
        .unwrap()
        .connect(&json!({}), Duration::from_secs(4))
        .await
        .unwrap();
    catalog.remove(&installed.id, &installed.revision).unwrap();
    assert_eq!(
        fs::read_dir(root.path().join("staging")).unwrap().count(),
        3
    );
    assert_eq!(catalog.collect().unwrap(), 0);
    crashed.kill().await.unwrap(); // OS termination: no Rust destructors run.
    assert!(crashed.wait().await.unwrap().code() != Some(0));
    assert_eq!(catalog.collect().unwrap(), 1);
    assert_eq!(
        fs::read_dir(root.path().join("staging")).unwrap().count(),
        2
    );
    assert_eq!(
        process
            .call(
                "acme.echo",
                json!("still connected"),
                Duration::from_secs(4)
            )
            .await
            .unwrap(),
        "still connected"
    );
    drop(local_review);
    assert_eq!(
        fs::read_dir(root.path().join("staging")).unwrap().count(),
        1
    );
    drop(surviving.stdin.take()); // Normal EOF runs review cleanup.
    assert!(
        tokio::time::timeout(Duration::from_secs(4), surviving.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    assert_eq!(
        fs::read_dir(root.path().join("staging")).unwrap().count(),
        0
    );
    process.close().await.unwrap();
    assert_eq!(catalog.collect().unwrap(), 1);
    assert_eq!(catalog.collect().unwrap(), 0);
}
