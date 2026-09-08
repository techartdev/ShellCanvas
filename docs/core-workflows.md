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

## Multiple host workspaces

CORE-07 replaces the singleton native connection with a registry and adds a top-bar workspace switcher. Connect adds an independent session, including a separate session for the same host if desired. A failed connection preserves existing workspaces. Disconnect and transport loss remove only the affected workspace; a reconnect has a fresh ID. Background workspace windows stay mounted but hidden/inert, preserving their terminal buffers, file navigation and window geometry. Local apps currently have one instance per workspace too; cross-workspace local app windows remain a future design choice.

App services capture a fixed session and omit profile/connection administration. The native registry checks terminal ownership on input/resize/close and rechecks a terminal's parent session after opening it. A disconnect while a terminal opens cannot attach the late terminal to another host. File operations capture their provider; disposed UI bindings reject late results. The Rust transport layer remains SSH-specific; this slice does not claim full composite adapter support or external-extension security.

`/tests/fixtures/workspaces.html` runs the real desktop with two fake hosts under React StrictMode. Browser checks exercised independent shell input and file paths, switching without reopening shells, failed connection preservation, and disconnecting the first host while the second kept receiving input. Native registry tests cover cross-host terminal rejection, close isolation and late terminal registration. Session-binding tests cover stale results, unsupported capabilities and late shell cleanup. This is fixture validation; simultaneous connections to two real devices remain unverified.

The remaining terminal black strip was xterm's default black viewport visible below whole-height text rows. Its background now explicitly matches the terminal theme; checks at multiple heights confirm that the spare pixels blend in above the footer.

Next: CORE-08 Files context actions and clipboard, followed by transfers and remote write workflows.
