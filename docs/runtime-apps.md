# Runtime apps and development workbenches

The Windows desktop now installs and runs self-contained app packages without rebuilding or restarting ShellCanvas. The browser preview uses the same catalog/window lifecycle with sandboxed browser documents. Native loading on other platforms remains gated until their isolation checks are completed. The full kernel objective is tracked in [kernel-roadmap.md](kernel-roadmap.md).

## Install an app in the desktop

**Install from GitHub** accepts a public repository/ref and verifies its root
descriptor and prebuilt package before the same installation review. See
[repository installation](repository-apps.md). Runtime app host services are
optional: the window can open without a connected device, while unavailable
remote methods remain disabled. Bundled apps with required host services retain
their connection requirement.

Open **Apps** from the dock or launcher, choose **Install package**, and select a `.shellcanvas.json` file. Review its version and requested permissions before choosing **Install app**. Installed apps appear in the launcher; running apps also appear in the dock. **Open app** in the manager creates a new window. A dock click restores an existing window; its context menu can create another.

Runtime apps use the same desktop stacking, minimize, maximize, window menu, dirty-close confirmation and native quit protection as bundled apps. Their instance holds a fixed package generation and grant snapshot. Updating or disabling a package preserves its existing windows. Removing a package requires its windows to be closed.

A host reconnect leaves the app's document and draft mounted. The previous session API is retired. The app's window then offers **Use reconnected host**: accepting explicitly directs subsequent requests to the new connection. Requests already dispatched retain their original scope and cannot silently change targets. Hiding/switching a workspace preserves windows while its shared dialogs are canceled. App-reported dirty/busy state participates in workspace-close and native-quit reviews.

The catalog persists in WebView IndexedDB, separate from host profiles. Desktop instances sharing the same WebView profile and catalog coordinate installation changes and running windows. The normal browser preview uses a different database name. No crash recovery for unsaved app documents is claimed.

## Build and load a separate app

From the repository root after `npm ci`:

```sh
node scripts/pack-app.mjs examples/dialog-app
npm run dev
```

Open `http://127.0.0.1:1420/tests/fixtures/runtime-app.html` and choose **Load built sample**. The package is `examples/dialog-app/dist/app.shellcanvas.json`. **Load package** also accepts a compiled package selected from disk. Rebuilding the app and loading it again needs no desktop rebuild or Vite restart. **Unload app** retires its channel and system-dialog scope.

The Field Notes example imports `connectToShellCanvas` from `@shellcanvas/app-sdk`. It opens a desktop message box, selects files using the shared picker, and saves text to an in-memory fixture provider through the shared Save As workflow. No real host or native filesystem is touched. The fixture provider supports new text files but deliberately does not offer replacement. Loaded package permissions are automatically granted in this developer-only workbench.

The compatibility packer delegates to the [standalone SDK's CLI](app-sdk.md), using `main.ts`, `style.css`, and `shellcanvas.json`. The SDK tarball now includes type declarations, schemas, a starter generator and build/validation tools. It is not yet published to npm. [Adapter tooling](adapter-sdk.md) and [repository AI skills](ai-development-skills.md) are also implemented; remaining work is listed in the kernel roadmap.

## Installation, updates and running windows

Open `http://127.0.0.1:1420/tests/fixtures/runtime-catalog.html` for the reusable package manager with persistent storage and normal desktop windows. Choose **Review built sample**, review its version and permissions, then **Install app**. Installation stores code, version and approved grants in IndexedDB; it does not execute the package until **Open app**. The workbench uses its own database, separate from host profiles and the read-only preview device. No SSH connection is made.

To exercise an update while keeping an unsaved note open:

```sh
node scripts/pack-app.mjs examples/dialog-app --version 0.2.0
```

Return to **Apps**, review the rebuilt package, and install the update. Existing windows retain their old package and grant snapshot; new launches use the new generation. New permissions are unselected during update review. A SHA-256 fingerprint identifies the reviewed content but is not publisher authentication. Reviews become invalid if the app changes before installation; stale writes from another catalog instance are rejected by an IndexedDB compare-and-set transaction.

**Disable** stops new launches and preserves existing work. It is not immediate revocation of already-running instances. **Remove** requires all of this catalog's windows for that app, including old generations, to be closed. Closing retires that instance's channel and document. Normal close confirmation uses app-reported dirty/busy state; a dishonest app can misreport its own work. Installed state persists across reloads; unsaved document recovery across crashes/restarts is not implemented.

The client exposes `client.window.setDocumentState({ dirty, busy, title? })`, window snapshots, focus/minimize/maximize/restore and guarded close requests. It can control only its own window, cannot provide a foreign window ID, and needs no remote-service grant. Field Notes reports draft edits and busy state; Save As marks the draft clean only if the saved text matches the current editor contents. See [window semantics](app-window.md), including close-channel teardown and inactive-workspace restrictions.

Render windows in stable mount order and change CSS stacking order when focusing them. Moving an iframe's DOM node can reload its browsing context. The catalog workbench maintains separate mount order and stacking order, so switching between versions does not reload either app.

Storage writes are serialized and commit before publishing a new in-memory state. Storage failure or a corrupt/unsupported catalog is reported without replacing it with an empty catalog. Running leases remain independent of storage refresh.

### Multiple desktop instances

Committed changes broadcast an invalidation to other instances. Each instance rereads and validates IndexedDB; notification messages cannot supply executable packages or grants. Focus, visibility restoration and a 30-second fallback also refresh the catalog. Unchanged revisions preserve snapshot identity and do not recreate running windows. A stale management decision still fails the atomic revision check and requires a fresh review.

Opening an installed app is asynchronous. It holds a shared per-app [Web Lock](https://www.w3.org/TR/web-locks/) and rereads the catalog before choosing the enabled package generation. Removing an app requires an exclusive lock with the same catalog/app identity, so running windows from any generation and any participating desktop instance prevent removal. Disable remains available and preserves existing work. Closing a window releases its lease; terminating its owning browser context also releases it, without timestamps or expiration that could mistake a paused desktop for a dead one. If coordination is unavailable, launch/removal fails explicitly. Separate browser/WebView profiles have separate storage and locks.

An asynchronous launch completing after desktop teardown releases its lease instead of creating an orphan window. A workspace removed while an app is opening similarly retires the prepared instance. Existing windows keep their original package and grant snapshot after an update, including when another process installs it.

The Windows two-process fixture passes 11 checks covering remote install/update/disable/removal, preserved generations/grants, refusal to remove while another process has running windows, and successful removal after the runner terminates that fixture process. It uses a unique synthetic catalog and no real host or clipboard. The full desktop regression fixture now passes 88 checks at both 1360×900 and 800×900, including Cut/Paste across bundled and installed apps and retained cleanup ownership/retry. This establishes Windows/WebView2 coordination; other native webviews still require equivalent evidence.

```powershell
$env:SHELLCANVAS_SDK_PROBE = '1'
npm run tauri -- build --debug --no-bundle --config src-tauri/tauri.catalog-probe.conf.json
node scripts/run-catalog-probe.mjs
```

The runner starts two hidden fixture processes, verifies their distinct IDs and terminates only its known test peer. Results are saved under `.local/native-extension-probe/catalog-coordination-result.json`. The fixture overwrites the debug executable; rebuild the normal desktop with `npm run tauri -- build --debug --no-bundle` afterward.

## Contract and lifetime

- A format-1 app package contains an ID, version, title, permission declarations, bundled JavaScript and CSS. It contains no remote entry URL or arbitrary outer document markup. Package records and permission arrays are immutable after parsing.
- Every loaded instance gets its own ordered JSON RPC channel. No request can select another instance's channel or pass a session ID. The host creates an explicit method map; method names never become dynamic property access or native command names.
- Required grants are checked before handler execution. The frame host intersects approved grants with declared grants. Namespaced methods, such as `acme.router.status`, are supported by the protocol without a kernel-wide enum change. [Discovery and state events](app-events.md) expose the registered method map. Runtime provider registration and custom-service routing still need implementation.
- Requests and replies carry protocol version 1 and monotonic request identities. Results can complete out of order. Duplicate incoming identities retire the channel; replies to canceled calls are ignored. Updating an instance creates a new channel rather than changing the old channel's target.
- Cancellation propagates an `AbortSignal`. Closing/revoking an instance rejects its pending calls, aborts its running handlers and drops late results. A provider must observe the signal for active work to stop. Cancellation cannot undo an already dispatched write; the core must not automatically retry it.
- The control channel allows 64 outstanding calls in each direction, messages up to 4 Mi UTF-16 units and JSON values up to 64 levels deep. These are control-message resource budgets, unrelated to remote folder size/depth. State events use one cancelable read with bounded history and explicit snapshot reset. [Console streams](app-console.md), [transfers](app-transfers.md) and the [native adapter protocol](adapter-process.md) define separate chunking, backpressure and lifetime rules.
- Wire errors use `invalid`, `closed`, `aborted`, `denied`, `unavailable`, `busy` and `failed`. Explicit `RpcError` messages and structured system errors are forwarded; arbitrary exceptions become a generic failure rather than exposing native paths, credentials or internal details.

Available bridged operations are `system.dialogs.messageBox`, `system.dialogs.openFile`, `system.dialogs.saveFile`, and `system.files.saveTextAs`. They validate JSON option shapes before reaching the trusted system UI. Open/Save require `system.dialogs` and `files.read`; Save As also requires `files.create`. The supplied window scope independently enforces device availability and whether replacement is allowed. A destination selection remains a location, not a write or overwrite grant.

## Isolation boundary and unfinished gates

The frame uses `sandbox="allow-scripts"` without `allow-same-origin`, a host-built document and a restrictive document CSP. The handshake checks both the exact iframe window and a per-document token before transferring its instance-owned port. The token rejects a queued handshake from an old document when a browser reuses the same iframe window. This follows the browser's [iframe sandbox model](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe). Native integration must additionally satisfy [Tauri's capability boundary](https://v2.tauri.app/security/capabilities/); a browser walkthrough is not proof of native IPC isolation.

This is not a security claim for arbitrary hostile packages. In particular, document CSP is not a universal navigation/network sandbox, and a same-renderer app can consume CPU or memory. The Windows navigation and direct-IPC checks are described below. Equivalent checks on other platforms, publisher authentication and stronger resource containment remain open. [Native adapters](adapter-process.md) use a distinct trusted-process model.

The original `runtime-app.html` channel workbench still immediately replaces/unloads its one sample, without preserving dirty app state. Use the desktop or catalog workbench for pinned generations and close confirmation. The desktop now supplies [app data and settings](app-storage.md), [state events](app-events.md) and [text clipboard access](app-clipboard.md) through the broker. The desktop also provides [window controls](app-window.md), [streaming consoles](app-console.md), [transfers](app-transfers.md), and [native adapters with independent replacement](adapter-packages.md). Use the kernel roadmap for remaining implementation and evidence gates.

## Evidence

`npm test -- src/extensions` exercises method grants, channel isolation, out-of-order replies, cancellation, retirement, replay rejection, malformed input, error redaction, message shapes and package validation. Browser walkthroughs exercise the separately compiled package through actual `MessagePort` channels and shared desktop dialogs. Native checks are separate evidence described below; none of these checks establishes full-goal completion.

The initial walkthrough loaded and reloaded the separately compiled Field Notes package, returned `ok` and `cancel` from a desktop message box, selected `welcome.md`, and created `field-notes.txt` in the in-memory provider with the submitted text and revision `fixture-1`. Escape restored focus to the initiating button. Unknown service calls returned `unavailable`, and unloading removed the frame. Save As originally failed against the intentionally read-only preview backend; the workbench now supplies its own explicit create-only fake provider. No real-host save was performed in this walkthrough.

The catalog walkthrough installed 0.1.0, entered an unsaved draft, installed 0.2.0 with `files.read` withheld, and opened both versions. The old window retained its exact draft and old grants; the new window's file picker request was denied. Switching focus initially exposed an iframe DOM-move reload; after the stable-mount fix, repeated focus changes and disabling retained the draft. **Keep working** preserved it, **Discard and close** retired its old instance, and removal was refused while windows were running. Reopening the workbench retained installed version 0.2.0, its two approved grants and disabled state. Removing it after the test windows closed persisted across a subsequent reload.

## Packaged Windows isolation probe

The native loader serves ephemeral, owner-bound HTML, JavaScript and CSS through `shellcanvas-app`. Package text is served as separate resources, never interpolated into native HTML script/style tags. Responses carry a sandbox policy, nonce-based script/style policy, correct MIME types and no-store headers. Closing a frame releases its resources, including publications that complete after their owner closes. Native publication is currently Windows-only; other platforms return an explicit unavailable error pending their own verification.

Build and run the separate native probe from the repository root:

```sh
npm run tauri -- build --debug --no-bundle --config src-tauri/tauri.extension-probe.conf.json
node scripts/run-extension-probe.mjs
```

The hidden WebView2 probe has its own application identity and touches only fake app resources. It reports to `.local/native-extension-probe/result.json`; the runner fails unless the structured result succeeds. Progress is saved in `progress.jsonl`. It tests approved and denied broker calls, stale handshakes, parent DOM and local-storage denial, CSS loading, blocked top navigation and IPC fetches, direct native-call attempts against a canary resource, and small/large native channel round trips. The debug-only channel command refuses calls outside the probe identity and environment. A watchdog makes incomplete runs fail rather than count as passes.

Wry 0.55.1 [documents that Windows ignores its main-frame-only initialization flag](https://docs.rs/wry/0.55.1/wry/struct.WebViewBuilder.html#method.with_initialization_script_for_main_only). The first native probe confirmed that Tauri's key-bearing transport was present in the child. ShellCanvas now uses `Builder::invoke_system` with Tauri's original transport templates enclosed in an early `window === window.top` guard. The small vendored templates retain their upstream license and serializer; see `src-tauri/vendor/tauri-ipc/README.md` for upgrade requirements. Child API wrappers can still exist, but the closure containing the invocation key must be absent. The guarded canary probe verifies this directly; merely hiding a global or relying on CSP was insufficient.

The probe build temporarily replaces `target/debug/shellcanvas.exe`. Restore the normal desktop afterwards:

```sh
npm run tauri -- build --debug --no-bundle
```

The normal desktop now permits only the host-managed app resource origin for native frames. This is not a claim of CPU/memory containment, arbitrary network-exfiltration prevention, or cross-platform isolation.

## Native desktop integration probe

```sh
npm run tauri -- build --debug --no-bundle --config src-tauri/tauri.desktop-probe.conf.json
node scripts/run-extension-probe.mjs
npm run tauri -- build --debug --no-bundle
```

This separate hidden native entry point renders the actual `App`, Apps manager, window manager and SDK example under React StrictMode. It supplies a dedicated test catalog and fake host services; no SSH connection is made. The fixture delivers a separately bundled package through the file-input change workflow, reviews and installs two versions, withholds file access from the update, verifies the old draft, checks shared dialogs and native quit protection, reconnects a fake host with explicit API rebinding, and exercises disable/removal/dirty-close behavior. It removes its test package after success. Selecting a file in the operating system's chooser is not automated by this probe.

For visual inspection in Vite, open `/tests/fixtures/native-desktop-probe.html?inspect=1`; it pauses with both versions running. Without `inspect`, the browser fixture runs through cleanup. Browser publication is deferred until the owner survives StrictMode's synthetic cleanup, and cleanup does not enqueue a competing srcdoc navigation. Native documents use the custom resource origin. Both keep the same opaque sandbox and token-bound handshake.

The browser walkthrough also clicked inside each overlapping app frame and verified that the corresponding desktop window became focused without reloading either draft. The shared dark color scheme keeps embedded scrollbars consistent with the desktop.
