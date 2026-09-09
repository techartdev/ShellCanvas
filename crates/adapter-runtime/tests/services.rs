// SPDX-License-Identifier: MPL-2.0
use serde_json::{json, Value};
use shellcanvas_adapter_runtime::{AdapterProcess, Launch};
use shellcanvas_services::{TerminalSize, TERMINAL_CHUNK};
use std::{path::PathBuf, time::Duration};
const DEADLINE: Duration = Duration::from_secs(4);
#[tokio::test]
async fn extended_text_and_settings_keep_revisions_and_readback_over_the_process_contract() {
    let process = fixture(json!({"standard":"both","extended":true})).await;
    let text = process.text().unwrap();
    let original = text.read_text("opaque:note").await.unwrap();
    let updated = text
        .save_text(&original.path, "A note 🌿\nЧас", &original.revision)
        .await
        .unwrap();
    assert_eq!(updated.text, "A note 🌿\nЧас");
    assert_ne!(updated.revision, original.revision);
    assert!(text
        .save_text(&original.path, "stale", &original.revision)
        .await
        .is_err());
    assert_eq!(
        text.read_text(&updated.path).await.unwrap().text,
        updated.text
    );
    let created = text
        .create_text("opaque:actions", "other.txt", "Created")
        .await
        .unwrap();
    assert!(created.path.starts_with("opaque:new:"));
    assert!(text
        .create_text("opaque:actions", "other.txt", "replace")
        .await
        .is_err());
    let settings = process.settings().unwrap();
    let field = settings.read().await.unwrap().remove(0);
    let confirmed = settings
        .apply(&field.id, "quiet", field.revision.as_deref().unwrap())
        .await
        .unwrap();
    assert_eq!(confirmed.value.as_deref(), Some("quiet"));
    assert!(settings
        .apply(&field.id, "normal", field.revision.as_deref().unwrap())
        .await
        .is_err());
    assert_eq!(
        settings.read().await.unwrap()[0].value.as_deref(),
        Some("quiet")
    );
    process.close().await.unwrap();
    assert!(text.read_text(&updated.path).await.is_err());
    assert!(settings.read().await.is_err());
}
#[tokio::test]
async fn extended_file_actions_preserve_provider_owned_relocation_maps() {
    let process = fixture(json!({"standard":"files","extended":true})).await;
    let actions = process.mutations().unwrap();
    let text = process.text().unwrap();
    let moves = process.moves().unwrap();
    let folder = actions
        .make_directory("opaque:actions", "Folder")
        .await
        .unwrap();
    assert!(actions
        .make_directory("opaque:actions", "Folder")
        .await
        .is_err());
    let note = text.read_text("opaque:note").await.unwrap();
    let renamed = actions
        .rename_tracked(
            &note.path,
            "renamed.txt",
            &note.revision,
            &[note.path.clone(), "unparseable://?child#1".into()],
        )
        .await
        .unwrap();
    assert_ne!(renamed.path, note.path);
    assert_eq!(renamed.locations.len(), 2);
    assert_eq!(renamed.locations[1].previous, "unparseable://?child#1");
    assert!(renamed.locations[1]
        .location
        .path
        .starts_with("opaque:mapped:"));
    let current = text.read_text(&renamed.path).await.unwrap();
    let moved = moves
        .move_tracked(&current.path, &folder, &current.revision, &[])
        .await
        .unwrap();
    let current = text.read_text(&moved.path).await.unwrap();
    assert_eq!(current.parent.as_deref(), Some(folder.as_str()));
    actions
        .remove_entry(&current.path, &current.revision)
        .await
        .unwrap();
    assert!(text.read_text(&current.path).await.is_err());
    process.close().await.unwrap();
}
#[tokio::test]
async fn optional_write_methods_cannot_turn_a_readonly_adapter_into_a_writer() {
    let process = fixture(json!({"standard":"files","extended":true,"readOnly":true})).await;
    assert!(process.mutations().is_none());
    assert!(process.moves().is_none());
    let text = process.text().unwrap();
    let document = text.read_text("opaque:note").await.unwrap();
    assert!(!document.writable);
    let settings = process.settings().unwrap();
    let field = settings.read().await.unwrap().remove(0);
    assert!(!field.writable);
    assert!(field.reason.unwrap().contains("read-only"));
    let before = process
        .call("acme.calls", Value::Null, DEADLINE)
        .await
        .unwrap()
        .as_u64()
        .unwrap();
    assert!(text
        .save_text(&document.path, "write", &document.revision)
        .await
        .is_err());
    assert!(text
        .create_text("opaque:actions", "write", "write")
        .await
        .is_err());
    assert!(settings
        .apply(&field.id, "quiet", field.revision.as_deref().unwrap())
        .await
        .is_err());
    let after = process
        .call("acme.calls", Value::Null, DEADLINE)
        .await
        .unwrap()
        .as_u64()
        .unwrap();
    assert_eq!(
        after,
        before + 1,
        "unsupported writes must not reach the process"
    );
    process.close().await.unwrap();
    let basic = fixture(json!({"standard":"files"})).await;
    assert!(basic.text().is_none());
    assert!(basic.settings().is_none());
    basic.close().await.unwrap();
}
#[tokio::test]
async fn malformed_mutation_responses_report_uncertainty_without_poisoning_other_services() {
    let process =
        fixture(json!({"standard":"both","extended":true,"badStandard":"files.saveText"})).await;
    let text = process.text().unwrap();
    let document = text.read_text("opaque:note").await.unwrap();
    let error = text
        .save_text(&document.path, "Changed", &document.revision)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("may have completed"));
    assert_eq!(
        text.read_text(&document.path).await.unwrap().text,
        document.text
    );
    let mut console = process
        .terminal()
        .unwrap()
        .open(TerminalSize::new(80, 24))
        .await
        .unwrap();
    console.writer.write(b"still usable").await.unwrap();
    assert_eq!(
        console.reader.read().await.unwrap().unwrap(),
        b"still usable"
    );
    console.writer.close().await.unwrap();
    process.close().await.unwrap();
}
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
