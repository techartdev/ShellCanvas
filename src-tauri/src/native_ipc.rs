// SPDX-License-Identifier: MPL-2.0
//! Preserve Tauri's IPC transport, but never initialize its secret-bearing closure in a subframe.
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
    // WebView2 ignores Wry's main-frame-only flag. This check runs before app code, and
    // Window.top is browser-owned. Keep the invocation key inside the guarded closure.
    format!("if (window === window.top) {{\n{transport}\n}}")
}
