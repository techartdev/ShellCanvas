# Windows keyboard/focus deadlock

The 2026-09-10 hang was diagnosed from the running process, before restart.
Its main thread held Tao 0.35.3's `KEY_EVENT_BUILDERS` mutex while handling a
key message. `PeekMessageW` dispatched a nested focus message through Wry's
`MoveFocus`, and the re-entered keyboard handler waited for that same mutex.
The SSH console was not on the blocked main-thread stack.

The workspace pins upstream Tao commit
[`87c46b52`](https://github.com/tauri-apps/tao/commit/87c46b52b4fc580cd79183f325cb6572ab689945),
the merged [Windows keyboard refactor (#1238)](https://github.com/tauri-apps/tao/pull/1238).
It moves keyboard state to the window and handles re-entry with a pending-event
queue, without holding the old global lock across message pumping. The commit
still declares version 0.35.3, compatible with the current Tauri runtime's
`^0.35` requirement. The registry's 0.35.3 does not contain this change.

Remove the Cargo patch when the supported Tauri runtime accepts a released Tao
version containing this fix. Keep the regression below when changing the pin.

## Regression

On Windows, run:

```powershell
cargo run -p shellcanvas --example windows_keyboard_regression
```

The example creates a hidden, isolated window. A worker sends a synchronous
focus message while a key message is being handled, forcing `PeekMessageW` to
re-enter the handler. It asserts that nested focus actually occurred and that
both keyboard processing and key release completed. A ten-second watchdog
exits with failure if the UI thread deadlocks. It does not connect to a host,
read the clipboard, or inject input into the user's desktop.

The same reproducer against registry Tao 0.35.3 hit the watchdog and exited 1
with `keyboard/focus reentrancy deadlocked`. Against the pinned upstream revision,
it passed with `nested focus and keyboard release completed without deadlock`.

The patched Windows build and this regression passed. Native ShellCanvas also
reopened, rendered its installed assistant, and accepted focus activation.
This verification is Windows-specific; it is not a macOS/Linux runtime test.
