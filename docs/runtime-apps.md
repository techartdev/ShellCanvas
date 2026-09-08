# Runtime app development workbench

The runtime-app boundary and package manager are currently available in the Vite development workbenches. The production native desktop still has `frame-src 'none'` and does not load these packages. Do not loosen that policy without completing the native isolation gates in [kernel-roadmap.md](kernel-roadmap.md).

## Build and load a separate app

From the repository root after `npm ci`:

```sh
node scripts/pack-app.mjs examples/dialog-app
npm run dev
```

Open `http://127.0.0.1:1420/tests/fixtures/runtime-app.html` and choose **Load built sample**. The package is `examples/dialog-app/dist/app.shellcanvas.json`. **Load package** also accepts a compiled package selected from disk. Rebuilding the app and loading it again needs no desktop rebuild or Vite restart. **Unload app** retires its channel and system-dialog scope.

The Field Notes example imports `connectToShellCanvas` from the developing client SDK. It opens a desktop message box, selects files using the shared picker, and saves text to an in-memory fixture provider through the shared Save As workflow. No real host or native filesystem is touched. The fixture provider supports new text files but deliberately does not offer replacement. Loaded package permissions are automatically granted in this developer-only workbench.

This packer currently uses the repository's esbuild dependency and fixed `main.ts`, `style.css`, and `shellcanvas.json` filenames. A standalone published SDK, package schema, starter generator, and AI skills remain deliverables, not current features.

## Installation, updates and running windows

Open `http://127.0.0.1:1420/tests/fixtures/runtime-catalog.html` for the reusable package manager with persistent storage and normal desktop windows. Choose **Review built sample**, review its version and permissions, then **Install app**. Installation stores code, version and approved grants in IndexedDB; it does not execute the package until **Open app**. The workbench uses its own database, separate from host profiles and the read-only preview device. No SSH connection is made.

To exercise an update while keeping an unsaved note open:

```sh
node scripts/pack-app.mjs examples/dialog-app --version 0.2.0
```

Return to **Apps**, review the rebuilt package, and install the update. Existing windows retain their old package and grant snapshot; new launches use the new generation. New permissions are unselected during update review. A SHA-256 fingerprint identifies the reviewed content but is not publisher authentication. Reviews become invalid if the app changes before installation; stale writes from another catalog instance are rejected by an IndexedDB compare-and-set transaction.

**Disable** stops new launches and preserves existing work. It is not immediate revocation of already-running instances. **Remove** requires all of this catalog's windows for that app, including old generations, to be closed. Closing retires that instance's channel and document. Normal close confirmation uses app-reported dirty/busy state; a dishonest app can misreport its own work. Installed state persists across reloads; unsaved document recovery across crashes/restarts is not implemented.

The developing client exposes `client.window.setDocumentState({ dirty, busy, title? })`. It can update only its own window, cannot provide a foreign window ID, and needs no remote-service grant. Field Notes reports draft edits and busy state; Save As marks the draft clean only if the saved text matches the current editor contents.

Render windows in stable mount order and change CSS stacking order when focusing them. Moving an iframe's DOM node can reload its browsing context. The catalog workbench maintains separate mount order and stacking order, so switching between versions does not reload either app.

Storage writes are serialized and commit before publishing a new in-memory state. Storage failure or a corrupt/unsupported catalog is reported without replacing it with an empty catalog. Running leases remain independent of storage refresh. Cross-desktop catalog changes currently require **Refresh installed apps**; automatic cross-process invalidation and global active-window coordination are not implemented.

## Contract and lifetime

- A format-1 app package contains an ID, version, title, permission declarations, bundled JavaScript and CSS. It contains no remote entry URL or arbitrary outer document markup. Package records and permission arrays are immutable after parsing.
- Every loaded instance gets its own ordered JSON RPC channel. No request can select another instance's channel or pass a session ID. The host creates an explicit method map; method names never become dynamic property access or native command names.
- Required grants are checked before handler execution. The frame host intersects approved grants with declared grants. Namespaced methods, such as `acme.router.status`, are supported by the protocol without a kernel-wide enum change. Discovery, provider registration and custom-service routing still need implementation.
- Requests and replies carry protocol version 1 and monotonic request identities. Results can complete out of order. Duplicate incoming identities retire the channel; replies to canceled calls are ignored. Updating an instance creates a new channel rather than changing the old channel's target.
- Cancellation propagates an `AbortSignal`. Closing/revoking an instance rejects its pending calls, aborts its running handlers and drops late results. A provider must observe the signal for active work to stop. Cancellation cannot undo an already dispatched write; the core must not automatically retry it.
- The control channel allows 64 outstanding calls in each direction, messages up to 4 Mi UTF-16 units and JSON values up to 64 levels deep. These are control-message resource budgets, unrelated to remote folder size/depth. Binary streams, events, backpressure and native-process framing are not implemented yet.
- Wire errors use `invalid`, `closed`, `aborted`, `denied`, `unavailable`, `busy` and `failed`. Explicit `RpcError` messages and structured system errors are forwarded; arbitrary exceptions become a generic failure rather than exposing native paths, credentials or internal details.

Available bridged operations are `system.dialogs.messageBox`, `system.dialogs.openFile`, `system.dialogs.saveFile`, and `system.files.saveTextAs`. They validate JSON option shapes before reaching the trusted system UI. Open/Save require `system.dialogs` and `files.read`; Save As also requires `files.create`. The supplied window scope independently enforces device availability and whether replacement is allowed. A destination selection remains a location, not a write or overwrite grant.

## Isolation boundary and unfinished gates

The frame uses `sandbox="allow-scripts"` without `allow-same-origin`, a host-built document and a restrictive document CSP. The handshake checks the exact iframe window before transferring its instance-owned port. This follows the browser's [iframe sandbox model](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe). Native integration must additionally satisfy [Tauri's capability boundary](https://v2.tauri.app/security/capabilities/); a browser walkthrough is not proof of native IPC isolation.

This is not yet a security claim for arbitrary hostile packages. In particular, document CSP is not a universal navigation/network sandbox, and a same-renderer app can consume CPU or memory. Native navigation handling, direct-IPC probes, platform-specific behavior, package provenance and reviewed grants need verification before this becomes a production install flow. Native adapters will have a distinct process trust model.

The original `runtime-app.html` channel workbench still immediately replaces/unloads its one sample, without preserving dirty app state. Use the catalog workbench for pinned generations and close confirmation. Production-native installation, persistent per-app data, clipboard, additional lifecycle events, streaming services, native adapters and their hot switching remain open in the roadmap.

## Evidence

`npm test -- src/extensions` exercises method grants, channel isolation, out-of-order replies, cancellation, retirement, replay rejection, malformed input, error redaction, message shapes and package validation. Browser walkthroughs exercise the separately compiled package through actual `MessagePort` channels and shared desktop dialogs. These checks do not establish full-goal completion or production-native readiness.

The initial walkthrough loaded and reloaded the separately compiled Field Notes package, returned `ok` and `cancel` from a desktop message box, selected `welcome.md`, and created `field-notes.txt` in the in-memory provider with the submitted text and revision `fixture-1`. Escape restored focus to the initiating button. Unknown service calls returned `unavailable`, and unloading removed the frame. Save As originally failed against the intentionally read-only preview backend; the workbench now supplies its own explicit create-only fake provider. No real-host save was performed in this walkthrough.

The catalog walkthrough installed 0.1.0, entered an unsaved draft, installed 0.2.0 with `files.read` withheld, and opened both versions. The old window retained its exact draft and old grants; the new window's file picker request was denied. Switching focus initially exposed an iframe DOM-move reload; after the stable-mount fix, repeated focus changes and disabling retained the draft. **Keep working** preserved it, **Discard and close** retired its old instance, and removal was refused while windows were running. Reopening the workbench retained installed version 0.2.0, its two approved grants and disabled state. Removing it after the test windows closed persisted across a subsequent reload.
