// SPDX-License-Identifier: MPL-2.0
//! Debug-build-only result capture for the actual WebView2 isolation probe.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{Listener, Runtime};

#[tauri::command]
pub fn live_clipboard_probe_context(app: tauri::AppHandle) -> Result<(), String> {
    if app.config().identifier == "dev.shellcanvas.extensionprobe"
        && std::env::var("SHELLCANVAS_EXTENSION_PROBE").as_deref() == Ok("1")
        && std::env::var("SHELLCANVAS_LIVE_CLIPBOARD_PROBE").as_deref() == Ok("1")
    {
        Ok(())
    } else {
        Err("Live clipboard probe requires explicit opt-in from its dedicated runner".into())
    }
}

#[tauri::command]
pub fn catalog_probe_context(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    if app.config().identifier != "dev.shellcanvas.extensionprobe"
        || std::env::var("SHELLCANVAS_EXTENSION_PROBE").as_deref() != Ok("1")
    {
        return Err("This command is available only to the native probe.".into());
    }
    let role = std::env::var("SHELLCANVAS_CATALOG_ROLE").unwrap_or_default();
    let run = std::env::var("SHELLCANVAS_CATALOG_RUN").unwrap_or_default();
    if !matches!(role.as_str(), "owner" | "peer") || uuid::Uuid::parse_str(&run).is_err() {
        return Err("Invalid catalog probe context".into());
    }
    Ok(serde_json::json!({"role": role, "run": run, "pid": std::process::id()}))
}

#[tauri::command]
pub fn channel_roundtrip(
    app: tauri::AppHandle,
    channel: tauri::ipc::Channel<Vec<u8>>,
    bytes: Vec<u8>,
) -> Result<usize, String> {
    if app.config().identifier != "dev.shellcanvas.extensionprobe"
        || std::env::var("SHELLCANVAS_EXTENSION_PROBE").as_deref() != Ok("1")
        || bytes.len() > 200_000
    {
        return Err("This command is available only to the native probe.".into());
    }
    let count = bytes.len();
    channel.send(bytes).map_err(|error| error.to_string())?;
    Ok(count)
}
pub fn setup<R: Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    if app.config().identifier != "dev.shellcanvas.extensionprobe"
        || std::env::var("SHELLCANVAS_EXTENSION_PROBE").as_deref() != Ok("1")
    {
        return Ok(());
    }
    let directory = std::env::current_dir()?.join(".local/native-extension-probe");
    std::fs::create_dir_all(&directory)?;
    let prefix = match std::env::var("SHELLCANVAS_CATALOG_ROLE").as_deref() {
        Ok("owner") => "catalog-owner-",
        Ok("peer") => "catalog-peer-",
        _ => "",
    };
    let result = directory.join(format!("{prefix}result.json"));
    let progress = directory.join(format!("{prefix}progress.jsonl"));
    std::fs::write(&progress, "")?;
    app.listen("shellcanvas-native-extension-progress", move |event| {
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(&progress) {
            let _ = writeln!(file, "{}", event.payload());
        }
    });
    let completed = Arc::new(AtomicBool::new(false));
    let done = completed.clone();
    let handle = app.handle().clone();
    let report = result.clone();
    app.listen("shellcanvas-native-extension-probe", move |event| {
        if done.swap(true, Ordering::SeqCst) {
            return;
        }
        let success = serde_json::from_str::<serde_json::Value>(event.payload())
            .ok()
            .is_some_and(|value| value["success"] == true);
        let written = std::fs::write(&report, event.payload()).is_ok();
        handle.exit(if success && written { 0 } else { 1 });
    });
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(45));
        if !completed.swap(true, Ordering::SeqCst) {
            let _ = std::fs::write(
                result,
                r#"{"success":false,"error":"Native extension probe timed out before completing."}"#,
            );
            handle.exit(1);
        }
    });
    Ok(())
}
