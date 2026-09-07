# Core workflow slice: terminal and saved hosts

## Implemented

The terminal has a constrained inner viewport with no padding for FitAddon to mismeasure. It clips painting without becoming another scroll container. The footer and tabs do not shrink. A coalesced ResizeObserver fits rows/columns after layout changes and font readiness; hidden windows are not fitted to zero dimensions. Context-menu focus restoration uses preventScroll so the browser cannot scroll the terminal wrapper to reach xterm's hidden input.

Terminal actions use xterm's selection, paste and clear APIs. Paste runs through xterm, preserving its bracketed-paste behavior. Ctrl+C is not intercepted. Clipboard text is read only for a user-triggered paste, not watched or cached. The native implementation uses the [official Tauri clipboard plugin](https://v2.tauri.app/plugin/clipboard/) with only read-text/write-text permissions; browser fixtures use a fake clipboard. The trusted bundled-webview boundary still applies.

Saved host profiles use a versioned, connector-tagged envelope. The current settings variant is SSH and deliberately has no fields for passwords or passphrases. IPC profile inputs reject unknown fields. Entries have stable UUIDs; names can be edited without changing identity. Saving an SSH-config import creates an application-owned entry; updating/removing it never writes to SSH config or the remote host.

Storage performs validation under a cross-process advisory lock, writes a same-directory temporary file, syncs it, and atomically replaces `hosts.json`. Read/modify/write operations run on the native blocking pool. Invalid/newer-version stores are left intact. This is local profile configuration, not a secret vault, full connection history or the final composite-workspace schema.

## Validation

- Rust tests cover persistence across reloads, update/removal, connector tags, rejected secret fields, preservation of corrupt/future files and concurrent saves.
- `/tests/fixtures/hosts.html` checks the real form against a fake store: create, edit, reopen, delete and ensure secret fields are never sent to persistence.
- `/tests/fixtures/terminal.html` checks real xterm with synthetic output and fake clipboard/I/O: resize, menu selection/copy/paste, focus restoration, footer bounds and keyboard menu opening without sending F10 to the shell. These fixture routes are development-only and are not packaged.
- Native OS clipboard round-trip testing is separate from the fake clipboard fixture. Multiple real host workspaces, Files context menus, transfers and remote writes are not delivered in this slice.
- Validation on Windows: 9 Rust tests, 11 frontend tests, Clippy with warnings denied, and the Tauri debug build passed. The rebuilt native app was launched and its desktop rendered successfully. Live remote clipboard use remains unverified.

## Next slice

CORE-07 introduces a host-session registry and workspace switcher. The current singleton connection must be removed before presenting simultaneous host sessions. Each window and terminal must own a session-specific service handle; switching, closing or reconnecting one host must not affect another. This concrete workflow should drive the next service-interface changes.
