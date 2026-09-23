// SPDX-License-Identifier: MPL-2.0
//! Preserve Tauri's IPC transport, but initialize its secret-bearing closure
//! only in the desktop's own top-level document.
pub fn initialization_script() -> String {
    let transport = include_str!("../vendor/tauri-ipc/ipc-protocol.js")
        .replace("__TEMPLATE_invoke_key__", "__INVOKE_KEY__")
        .replace(
            "__RAW_process_ipc_message_fn__",
            include_str!("../vendor/tauri-ipc/process-ipc-message-fn.js"),
        )
        .replace(
            "__TEMPLATE_os_name__",
            &serde_json::to_string(std::env::consts::OS).unwrap(),
        )
        .replace(
            "__TEMPLATE_fetch_channel_data_command__",
            // Private Tauri 2.11.5 wire constant, kept with the matching vendored templates.
            "\"plugin:__TAURI_CHANNEL__|fetch\"",
        );
    // WebView2 ignores Wry's main-frame-only flag. On WebKit, an app document
    // could also become the top-level page after a navigation. Check both the
    // browser-owned frame identity and the exact trusted desktop origin before
    // constructing the invocation-key closure.
    let trusted = if cfg!(dev) {
        "http://127.0.0.1:1420"
    } else {
        if cfg!(windows) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
    };
    format!(
        "if (window === window.top && window.location.protocol + '//' + window.location.host === {trusted:?}) {{\n{transport}\n}}"
    )
}
