// SPDX-License-Identifier: MPL-2.0
use serde_json::{json, Value};
use shellcanvas_adapter_runtime::{AdapterProcess, Launch};
use shellcanvas_services::{copy_regular_file, TRANSFER_CHUNK};
use std::{path::PathBuf, time::Duration};
const DEADLINE: Duration = Duration::from_secs(5);
#[tokio::test]
async fn canceled_stream_call_cannot_resume_at_an_unknown_offset_or_affect_a_sibling() {
    let process = fixture(json!({"transferDelayMethod":"files.download.read"})).await;
    let mut reader = process
        .transfers()
        .unwrap()
        .download("blob", "1")
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(20), reader.read())
            .await
            .is_err()
    );
    assert!(reader
        .read()
        .await
        .unwrap_err()
        .to_string()
        .contains("last operation"));
    reader.abort().await.unwrap();
    let mut writer = process
        .transfers()
        .unwrap()
        .upload("parent", "sibling", 0)
        .await
        .unwrap();
    writer.finish().await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(stats(&process).await["active"], 0);
    assert_eq!(stats(&process).await["published"], 1);
    process.close().await.unwrap();
}
#[tokio::test]
async fn source_verification_failure_prevents_copy_publication_and_bad_publish_reply_is_uncertain()
{
    let process = fixture(json!({"transferFault":"files.download.finish"})).await;
    assert!(copy_regular_file(
        process.transfers().unwrap(),
        "blob",
        "1",
        "parent",
        "copy",
        || false,
        &mut |_| {}
    )
    .await
    .is_err());
    assert_eq!(stats(&process).await["published"], 0);
    assert_eq!(stats(&process).await["active"], 0);
    process.close().await.unwrap();
    let process = fixture(json!({"transferFault":"files.upload.finish"})).await;
    let mut writer = process
        .transfers()
        .unwrap()
        .upload("parent", "empty", 0)
        .await
        .unwrap();
    assert!(writer
        .finish()
        .await
        .unwrap_err()
        .to_string()
        .contains("inspect it before retrying"));
    assert!(writer.finish().await.is_err());
    writer.abort().await.unwrap();
    process.close().await.unwrap();
}
async fn fixture(extra: Value) -> AdapterProcess {
    let mut config = json!({"standard":"both","transfers":"both","folders":true});
    config
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
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
async fn stats(process: &AdapterProcess) -> Value {
    process
        .call("acme.transferStats", Value::Null, DEADLINE)
        .await
        .unwrap()
}
async fn wait_stat(process: &AdapterProcess, key: &str, count: usize) {
    tokio::time::timeout(DEADLINE, async {
        loop {
            if stats(process).await[key] == count {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn binary_copy_uses_chunked_streams_and_refuses_overwrite_and_stale_sources() {
    let process = fixture(json!({"bytes":200_003})).await;
    let service = process.transfers().unwrap();
    assert!(service.clone().download("blob", "stale").await.is_err());
    wait_stat(&process, "active", 0).await;
    let mut progress = vec![];
    let copied = copy_regular_file(
        service.clone(),
        "blob",
        "1",
        "opaque:destination",
        "copied.bin",
        || false,
        &mut |p| progress.push(p.bytes),
    )
    .await
    .unwrap();
    assert!(progress.len() > 6);
    let mut reader = service.clone().download(&copied.path, "1").await.unwrap();
    let mut bytes = vec![];
    loop {
        let chunk = reader.read().await.unwrap();
        if chunk.is_empty() {
            break;
        }
        assert!(chunk.len() <= TRANSFER_CHUNK);
        bytes.extend(chunk);
    }
    reader.finish().await.unwrap();
    assert_eq!(
        bytes,
        (0..200_003).map(|n| (n % 256) as u8).collect::<Vec<_>>()
    );
    assert!(reader.read().await.is_err());
    assert!(copy_regular_file(
        service,
        "blob",
        "1",
        "opaque:destination",
        "copied.bin",
        || false,
        &mut |_| {}
    )
    .await
    .is_err());
    assert_eq!(stats(&process).await["published"], 1);
    assert_eq!(stats(&process).await["active"], 0);
    process.close().await.unwrap();
}
#[tokio::test]
async fn directories_page_without_entry_cap_and_mkdir_preserves_opaque_locations() {
    let process = fixture(json!({"entries":20_000})).await;
    let service = process.transfers().unwrap();
    assert!(service.supports_folders());
    let entry = service.clone().transfer_entry("tree", "1").await.unwrap();
    assert_eq!(entry.kind, "directory");
    let mut directory = service
        .clone()
        .transfer_directory(&entry.path, &entry.revision)
        .await
        .unwrap();
    let mut count = 0;
    loop {
        let page = directory.next().await.unwrap();
        if page.is_empty() {
            break;
        }
        assert!(page.len() <= 128);
        count += page.len();
    }
    assert_eq!(count, 20_000);
    assert_eq!(stats(&process).await["active"], 1);
    directory.finish().await.unwrap();
    assert!(directory.next().await.is_err());
    let folder = service
        .transfer_mkdir("opaque:destination", "Empty folder")
        .await
        .unwrap();
    assert!(folder.path.starts_with("opaque:folder:"));
    assert!(service
        .transfer_mkdir("opaque:destination", "Empty folder")
        .await
        .is_err());
    assert_eq!(stats(&process).await["active"], 0);
    process.close().await.unwrap();
}
#[tokio::test]
async fn abandoned_pending_open_retires_before_late_setup_and_recovers_capacity() {
    let process = fixture(json!({"transferOpenDelay":250})).await;
    let service = process.transfers().unwrap();
    let opening =
        tokio::spawn(async move { service.upload("opaque:destination", "abandoned", 10).await });
    wait_stat(&process, "opens", 1).await;
    opening.abort();
    let _ = opening.await;
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert_eq!(stats(&process).await["active"], 0);
    assert_eq!(stats(&process).await["published"], 0);
    let mut reader = process
        .transfers()
        .unwrap()
        .download("blob", "1")
        .await
        .unwrap();
    reader.abort().await.unwrap();
    process.close().await.unwrap();
}
#[tokio::test]
async fn open_handle_budget_is_shared_and_abandoned_handles_release_only_after_cleanup() {
    let process = fixture(json!({})).await;
    let mut readers = vec![];
    for _ in 0..32 {
        readers.push(
            process
                .transfers()
                .unwrap()
                .download("blob", "1")
                .await
                .unwrap(),
        );
    }
    assert!(process
        .transfers()
        .unwrap()
        .upload("opaque:destination", "excess", 0)
        .await
        .is_err());
    assert_eq!(stats(&process).await["opens"], 32);
    readers.pop().unwrap().abort().await.unwrap();
    let mut writer = process
        .transfers()
        .unwrap()
        .upload("opaque:destination", "empty", 0)
        .await
        .unwrap();
    writer.finish().await.unwrap();
    drop(readers);
    wait_stat(&process, "active", 0).await;
    process.close().await.unwrap();
}
#[tokio::test]
async fn unsupported_directions_and_incomplete_or_oversized_writes_do_not_publish() {
    let process = fixture(json!({"transfers":"download","folders":false})).await;
    let service = process.transfers().unwrap();
    assert!(!process.uploads_supported());
    assert!(!service.supports_folders());
    assert!(service.clone().upload("parent", "name", 0).await.is_err());
    assert!(service
        .clone()
        .transfer_directory("tree", "1")
        .await
        .is_err());
    assert_eq!(stats(&process).await["opens"], 0);
    assert_eq!(
        service.transfer_entry("blob", "1").await.unwrap().kind,
        "file"
    );
    process.close().await.unwrap();
    let process = fixture(json!({"transfers":"upload"})).await;
    let service = process.transfers().unwrap();
    assert!(!process.downloads_supported());
    assert!(service.clone().download("blob", "1").await.is_err());
    let mut writer = service.upload("parent", "name", 2).await.unwrap();
    assert!(writer.write(&vec![0; TRANSFER_CHUNK + 1]).await.is_err());
    writer.write(&[1]).await.unwrap();
    assert!(writer.finish().await.is_err());
    assert!(writer.write(&[2]).await.is_err());
    writer.abort().await.unwrap();
    assert_eq!(stats(&process).await["published"], 0);
    process.close().await.unwrap();
}
#[tokio::test]
async fn malformed_stream_response_poisoning_is_local_and_cleanup_failure_keeps_budget_charged() {
    let process = fixture(json!({"transferFault":"files.download.read"})).await;
    let mut reader = process
        .transfers()
        .unwrap()
        .download("blob", "1")
        .await
        .unwrap();
    assert!(reader.read().await.is_err());
    assert!(reader
        .read()
        .await
        .unwrap_err()
        .to_string()
        .contains("last operation"));
    reader.abort().await.unwrap();
    assert_eq!(
        process.files().unwrap().preview("anything").await.unwrap(),
        "Synthetic adapter item"
    );
    process.close().await.unwrap();
    let process = fixture(json!({"transferFault":"files.transfer.abort"})).await;
    let mut readers = vec![];
    for _ in 0..32 {
        readers.push(
            process
                .transfers()
                .unwrap()
                .download("blob", "1")
                .await
                .unwrap(),
        );
    }
    for reader in &mut readers {
        assert!(reader.abort().await.is_err());
    }
    assert!(process
        .transfers()
        .unwrap()
        .download("blob", "1")
        .await
        .is_err());
    process.close().await.unwrap();
    assert!(readers[0].read().await.is_err());
}
