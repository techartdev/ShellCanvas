// SPDX-License-Identifier: MPL-2.0
use serde_json::{json, Value};
use shellcanvas_adapter_runtime::{AdapterProcess, Launch};
use shellcanvas_services::{TerminalSize, TERMINAL_CHUNK};
use std::{path::PathBuf, time::Duration};
const DEADLINE: Duration = Duration::from_secs(4);
#[tokio::test]
async fn custom_service_bridge_preserves_catalog_errors_and_process_lifetime() {
    let process = fixture(json!({})).await;
    let service = process.custom("acme").unwrap();
    assert_eq!(service.descriptor().id, "acme");
    assert!(process.custom("system").is_none());
    assert!(process.custom("files").is_none());
    assert_eq!(
        service
            .call("acme.echo", json!({"nested":[1,true,null]}))
            .await
            .unwrap(),
        json!({"nested":[1,true,null]})
    );
    assert_eq!(
        service
            .call("system.adapter.initialize", Value::Null)
            .await
            .unwrap_err()
            .code,
        "unavailable"
    );
    assert_eq!(
        service
            .call("acme.fail", Value::Null)
            .await
            .unwrap_err()
            .code,
        "denied"
    );
    process.close().await.unwrap();
    assert!(service.call("acme.echo", Value::Null).await.is_err());
}
async fn fixture(config: Value) -> AdapterProcess {
    AdapterProcess::launch(
        Launch {
            executable: PathBuf::from(env!("CARGO_BIN_EXE_fixture-adapter")),
            arguments: vec![],
            directory: std::env::current_dir().unwrap(),
        },
        config,
        DEADLINE,
    )
    .await
    .unwrap()
}
#[tokio::test]
async fn paged_files_preserve_opaque_locations_and_independent_console_stays_live() {
    let files = fixture(json!({"standard":"files", "entries":20_000})).await;
    let serial = fixture(json!({"standard":"console", "resizable":false})).await;
    assert!(files.terminal().is_none());
    assert!(serial.files().is_none());
    let service = files.files().unwrap();
    let listing = service.list(None).await.unwrap();
    assert_eq!(listing.entries.len(), 20_000);
    assert_eq!(listing.path, "device://inventory?root=main");
    let opaque = "not/a/filesystem/../path?device=1#port";
    assert_eq!(service.locate(opaque).await.unwrap().path, opaque);
    assert_eq!(
        service.preview(opaque).await.unwrap(),
        "Synthetic adapter item"
    );
    let mut console = serial
        .terminal()
        .unwrap()
        .open(TerminalSize::new(80, 24))
        .await
        .unwrap();
    assert!(!console.resizable);
    assert!(console
        .writer
        .resize(TerminalSize::new(100, 30))
        .await
        .is_err());
    files.close().await.unwrap();
    assert!(service.list(None).await.is_err());
    let bytes = [0, 0xFF, 0xF0, 0x9F, 0x8C, 0xBF];
    console.writer.write(&bytes).await.unwrap();
    assert_eq!(console.reader.read().await.unwrap().unwrap(), bytes);
    console.writer.close().await.unwrap();
    serial.close().await.unwrap();
}
#[tokio::test]
async fn separate_console_halves_support_pending_reads_close_and_drop_cleanup() {
    let adapter = fixture(json!({"standard":"console","resizable":true})).await;
    let service = adapter.terminal().unwrap();
    let first = service.open(TerminalSize::new(80, 24)).await.unwrap();
    let mut reader = first.reader;
    let mut writer = first.writer;
    let reading = tokio::spawn(async move { reader.read().await });
    let mut second = service.open(TerminalSize::new(80, 24)).await.unwrap();
    second
        .writer
        .resize(TerminalSize::new(100, 30))
        .await
        .unwrap();
    writer.write(&vec![0xFE; TERMINAL_CHUNK]).await.unwrap();
    let result = tokio::time::timeout(DEADLINE, reading)
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(result, vec![0xFE; TERMINAL_CHUNK]);
    writer.close().await.unwrap();
    assert!(writer.write(&[1]).await.is_err());
    second.writer.write(&[2]).await.unwrap();
    assert_eq!(second.reader.read().await.unwrap().unwrap(), [2]);
    drop(second);
    wait_count(&adapter, "acme.consoleCount", 0).await;
    adapter.close().await.unwrap();
}
async fn wait_count(adapter: &AdapterProcess, method: &str, target: u64) {
    tokio::time::timeout(DEADLINE, async {
        loop {
            if adapter.call(method, Value::Null, DEADLINE).await.unwrap() == target {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn abandoned_open_is_closed_before_a_late_adapter_completion() {
    let adapter = fixture(json!({"standard":"console","openDelay":200})).await;
    let service = adapter.terminal().unwrap();
    let opening = tokio::spawn(async move { service.open(TerminalSize::new(80, 24)).await });
    wait_count(&adapter, "acme.openCount", 1).await;
    opening.abort();
    let _ = opening.await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    wait_count(&adapter, "acme.consoleCount", 0).await;
    adapter.close().await.unwrap();
}
#[tokio::test]
async fn changing_directory_mid_page_is_an_error_not_a_mixed_listing() {
    let adapter = fixture(json!({"standard":"files","changedPage":true})).await;
    assert!(adapter
        .files()
        .unwrap()
        .list(None)
        .await
        .unwrap_err()
        .to_string()
        .contains("changed directory"));
    adapter.close().await.unwrap();
}
