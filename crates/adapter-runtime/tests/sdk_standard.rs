// SPDX-License-Identifier: MPL-2.0
// Run the exact SDK example sources, or the independently generated packages.
use serde_json::{json, Value};
use shellcanvas_adapter_runtime::{AdapterProcess, Launch};
use shellcanvas_services::TerminalSize;
use std::{path::PathBuf, time::Duration};
const DEADLINE: Duration = Duration::from_secs(4);

async fn example(kind: &str) -> AdapterProcess {
    let fallback = match kind {
        "FILES" => env!("CARGO_BIN_EXE_sdk-files"),
        "CONSOLE" => env!("CARGO_BIN_EXE_sdk-console"),
        "SETTINGS" => env!("CARGO_BIN_EXE_sdk-settings"),
        _ => unreachable!(),
    };
    let executable = std::env::var_os(format!("SHELLCANVAS_SDK_{kind}_EXE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| fallback.into());
    AdapterProcess::launch(
        Launch {
            directory: executable.parent().unwrap().into(),
            executable,
            arguments: vec![],
        },
        json!({}),
        DEADLINE,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn files_starter_pages_opaque_inventory_and_advertises_only_read_support() {
    let process = example("FILES").await;
    assert!(process.terminal().is_none());
    assert!(process.settings().is_none());
    assert!(process.mutations().is_none());
    assert!(process.moves().is_none());
    let files = process.files().unwrap();
    let listing = files.list(None).await.unwrap();
    assert_eq!(listing.path, "inventory:?collection=demo#root");
    assert_eq!(listing.entries.len(), 300);
    let mut seen = std::collections::HashSet::new();
    let mut cursor = Value::Null;
    loop {
        let page = process
            .call(
                "files.list",
                json!({"path":listing.path,"cursor":cursor,"limit":7}),
                DEADLINE,
            )
            .await
            .unwrap();
        let entries = page["directory"]["entries"].as_array().unwrap();
        assert!(entries.len() <= 7);
        for entry in entries {
            assert!(seen.insert(entry["path"].as_str().unwrap().to_owned()));
        }
        cursor = page["next"].clone();
        if cursor.is_null() {
            break;
        }
    }
    assert_eq!(seen.len(), 300);
    for params in [
        json!({"path":listing.path,"cursor":"inventory-v0:7","limit":7}),
        json!({"path":"different-device","cursor":"inventory-v1:7","limit":7}),
        json!({"path":listing.path,"cursor":false,"limit":7}),
    ] {
        assert!(process.call("files.list", params, DEADLINE).await.is_err());
    }
    let entry = &listing.entries[299];
    let located = files.locate(&entry.path).await.unwrap();
    assert_eq!(located.parent.as_deref(), Some(listing.path.as_str()));
    assert!(files.preview(&entry.path).await.unwrap().contains("299"));
    let text = process.text().unwrap();
    let document = text.read_text(&entry.path).await.unwrap();
    assert_eq!(document.revision, entry.revision);
    assert!(!document.writable);
    assert!(text
        .save_text(&entry.path, "change", &entry.revision)
        .await
        .is_err());
    assert!(files.locate("/etc/passwd").await.is_err());
    process.close().await.unwrap();
    assert!(files.list(None).await.is_err());
}

#[tokio::test]
async fn settings_starter_checks_concurrent_revisions_and_returns_committed_state() {
    let process = example("SETTINGS").await;
    assert!(process.files().is_none());
    assert!(process.terminal().is_none());
    let settings = process.settings().unwrap();
    let field = settings.read().await.unwrap().remove(0);
    let revision = field.revision.as_deref().unwrap();
    let (first, second) = tokio::join!(
        settings.apply(&field.id, "quiet", revision),
        settings.apply(&field.id, "normal", revision)
    );
    assert_ne!(
        first.is_ok(),
        second.is_ok(),
        "Only one operation may commit the reviewed revision"
    );
    let applied = first.or(second).unwrap();
    assert_ne!(applied.revision, field.revision);
    let readback = settings.read().await.unwrap().remove(0);
    assert_eq!(readback.value, applied.value);
    assert_eq!(readback.revision, applied.revision);
    assert!(settings
        .apply(
            &field.id,
            "invalid mode",
            readback.revision.as_deref().unwrap()
        )
        .await
        .is_err());
    assert_eq!(
        settings.read().await.unwrap()[0].revision,
        readback.revision
    );
    process.close().await.unwrap();
    assert!(settings.read().await.is_err());
    let fresh = example("SETTINGS").await;
    assert_eq!(
        fresh.settings().unwrap().read().await.unwrap()[0]
            .value
            .as_deref(),
        Some("normal")
    );
    fresh.close().await.unwrap();
}

#[tokio::test]
async fn console_starter_supports_binary_concurrency_and_independent_sessions() {
    let process = example("CONSOLE").await;
    assert!(process.files().is_none());
    assert!(process.settings().is_none());
    let terminal = process.terminal().unwrap();
    let mut first = terminal.open(TerminalSize::new(80, 24)).await.unwrap();
    let mut second = terminal.open(TerminalSize::new(80, 24)).await.unwrap();
    assert!(!first.resizable);
    assert!(first
        .writer
        .resize(TerminalSize::new(100, 30))
        .await
        .is_err());
    let bytes = [0, 255, 0xf0, 0x9f, 0x8c, 0xbf];
    let (read, write) = tokio::join!(first.reader.read(), first.writer.write(&bytes));
    write.unwrap();
    assert_eq!(read.unwrap().unwrap(), bytes);
    first.writer.close().await.unwrap();
    second.writer.write(b"independent").await.unwrap();
    assert_eq!(second.reader.read().await.unwrap().unwrap(), b"independent");
    let (read, close) = tokio::join!(second.reader.read(), second.writer.close());
    // Explicit host-side close retires both halves immediately, even if the
    // adapter returns EOF to the already dispatched read.
    assert!(read.unwrap_err().to_string().contains("console is closed"));
    close.unwrap();
    process.close().await.unwrap();
}

#[tokio::test]
async fn console_starter_cancels_reads_and_refuses_to_revive_retired_ids() {
    let process = example("CONSOLE").await;
    process
        .call(
            "console.close",
            json!({"id":"closed-before-open"}),
            DEADLINE,
        )
        .await
        .unwrap();
    assert!(process
        .call(
            "console.open",
            json!({"id":"closed-before-open","cols":80,"rows":24}),
            DEADLINE
        )
        .await
        .is_err());
    process
        .call(
            "console.open",
            json!({"id":"live","cols":80,"rows":24}),
            DEADLINE,
        )
        .await
        .unwrap();
    let read = json!({"id":"live","maxBytes":65536,"waitMs":1000});
    assert!(process
        .call("console.read", read.clone(), Duration::from_millis(50))
        .await
        .is_err());
    // A canceled read must neither eat the later bytes nor retire the connection.
    process
        .call(
            "console.write",
            json!({"id":"live","bytes":[0,255,128]}),
            DEADLINE,
        )
        .await
        .unwrap();
    assert_eq!(
        process
            .call("console.read", read.clone(), DEADLINE)
            .await
            .unwrap()["bytes"],
        json!([0, 255, 128])
    );
    let waiting = process.call("console.read", read.clone(), DEADLINE);
    let closing = process.call("console.close", json!({"id":"live"}), DEADLINE);
    let (waiting, closing) = tokio::join!(waiting, closing);
    closing.unwrap();
    assert_eq!(waiting.unwrap(), json!({"bytes":[],"closed":true}));
    assert_eq!(
        process.call("console.read", read, DEADLINE).await.unwrap()["closed"],
        true
    );
    assert!(process
        .call(
            "console.open",
            json!({"id":"live","cols":80,"rows":24}),
            DEADLINE
        )
        .await
        .is_err());
    process.close().await.unwrap();
}

#[tokio::test]
async fn console_starter_bounds_pending_output_without_truncating_writes() {
    let process = example("CONSOLE").await;
    process
        .call(
            "console.open",
            json!({"id":"buffer","cols":80,"rows":24}),
            DEADLINE,
        )
        .await
        .unwrap();
    let chunk = vec![254u8; 65536];
    for _ in 0..4 {
        process
            .call(
                "console.write",
                json!({"id":"buffer","bytes":chunk}),
                DEADLINE,
            )
            .await
            .unwrap();
    }
    assert!(process
        .call(
            "console.write",
            json!({"id":"buffer","bytes":[7]}),
            DEADLINE
        )
        .await
        .is_err());
    for _ in 0..4 {
        let read = process
            .call(
                "console.read",
                json!({"id":"buffer","maxBytes":65536,"waitMs":0}),
                DEADLINE,
            )
            .await
            .unwrap();
        assert_eq!(read["bytes"], json!(chunk));
    }
    assert_eq!(
        process
            .call(
                "console.read",
                json!({"id":"buffer","maxBytes":1,"waitMs":0}),
                DEADLINE
            )
            .await
            .unwrap(),
        json!({"bytes":[],"closed":false})
    );
    process.close().await.unwrap();
}

#[tokio::test]
async fn dropping_console_halves_releases_capacity_without_closing_other_sessions() {
    let process = example("CONSOLE").await;
    let terminal = process.terminal().unwrap();
    let mut sessions = Vec::new();
    for _ in 0..32 {
        sessions.push(terminal.open(TerminalSize::new(80, 24)).await.unwrap());
    }
    assert!(terminal.open(TerminalSize::new(80, 24)).await.is_err());
    drop(sessions.pop());
    let mut replacement = tokio::time::timeout(DEADLINE, async {
        loop {
            if let Ok(session) = terminal.open(TerminalSize::new(80, 24)).await {
                break session;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Dropping both halves must release the adapter session");
    sessions[0].writer.write(b"retained").await.unwrap();
    assert_eq!(
        sessions[0].reader.read().await.unwrap().unwrap(),
        b"retained"
    );
    replacement.writer.write(b"new").await.unwrap();
    assert_eq!(replacement.reader.read().await.unwrap().unwrap(), b"new");
    drop(sessions);
    drop(replacement);
    process.close().await.unwrap();
}
