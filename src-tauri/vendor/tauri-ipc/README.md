# Tauri IPC transport

These two unmodified JavaScript templates come from Tauri 2.11.5, under its MIT license (included here):

- https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/scripts/ipc-protocol.js
- https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/scripts/process-ipc-message-fn.js

`src/native_ipc.rs` fills the original template values and uses Tauri's supported `Builder::invoke_system` hook to enclose the transport in a main-frame guard. Wry 0.55.1's Windows backend injects scripts into subframes regardless of its main-frame-only flag. A sandboxed app must never receive the closure containing the native invocation key. Hiding globals after app code starts is not an isolation boundary.

Keep these templates and their license together. When upgrading Tauri, compare its transport/serialization templates and rerun the native extension probe, native channel tests, and desktop regression checks. The guard does not replace sandboxing, native capability checks or the app RPC broker.
