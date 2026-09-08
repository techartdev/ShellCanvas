# Runtime app development workbench

This is the first executable runtime-app boundary, not the finished extension manager. It is currently available in the Vite development workbench only. The production native desktop still has `frame-src 'none'` and does not load these packages. Do not loosen that policy without completing the native isolation gates in [kernel-roadmap.md](kernel-roadmap.md).

## Build and load a separate app

From the repository root after `npm ci`:

```sh
node scripts/pack-app.mjs examples/dialog-app
npm run dev
```

Open `http://127.0.0.1:1420/tests/fixtures/runtime-app.html` and choose **Load built sample**. The package is `examples/dialog-app/dist/app.shellcanvas.json`. **Load package** also accepts a compiled package selected from disk. Rebuilding the app and loading it again needs no desktop rebuild or Vite restart. **Unload app** retires its channel and system-dialog scope.

The Field Notes example imports `connectToShellCanvas` from the developing client SDK. It opens a desktop message box, selects files using the shared picker, and saves text to an in-memory fixture provider through the shared Save As workflow. No real host or native filesystem is touched. The fixture provider supports new text files but deliberately does not offer replacement. Loaded package permissions are automatically granted in this developer-only workbench.

This packer currently uses the repository's esbuild dependency and fixed `main.ts`, `style.css`, and `shellcanvas.json` filenames. A standalone published SDK, package schema, install persistence, starter generator, and AI skills remain deliverables, not current features.

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

The workbench immediately replaces/unloads its sample. It does not preserve dirty app state or review unsaved work. Production updates must keep existing instances pinned to their old generation, with explicit retirement, rather than copying this test control into the desktop. Installation/update/removal, persistent per-app data, clipboard, lifecycle events, streaming services, native adapters and their hot switching remain open in the roadmap.

## Evidence

`npm test -- src/extensions` exercises method grants, channel isolation, out-of-order replies, cancellation, retirement, replay rejection, malformed input, error redaction, message shapes and package validation. Browser walkthroughs exercise the separately compiled package through actual `MessagePort` channels and shared desktop dialogs. These checks do not establish full-goal completion or production-native readiness.

The initial walkthrough loaded and reloaded the separately compiled Field Notes package, returned `ok` and `cancel` from a desktop message box, selected `welcome.md`, and created `field-notes.txt` in the in-memory provider with the submitted text and revision `fixture-1`. Escape restored focus to the initiating button. Unknown service calls returned `unavailable`, and unloading removed the frame. Save As originally failed against the intentionally read-only preview backend; the workbench now supplies its own explicit create-only fake provider. No real-host save was performed in this walkthrough.
