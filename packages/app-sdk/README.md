# ShellCanvas app SDK

Build desktop apps that install while ShellCanvas is running. The SDK supplies typed, window-owned system services over the desktop's isolated app channel. It needs no React, Tauri or Node dependency in the app bundle. The included CLI uses Node and esbuild at development time.

Version **0.1.0 is provisional and not published to npm yet**. Use a packed SDK tarball from the ShellCanvas repository or a project release. Do not assume the npm package name is available until an official release says so.

## Create and build an app

With this package installed as a development dependency:

```sh
shellcanvas-app init ./my-app --id org.example.notes --title "Notes" --sdk /absolute/path/shellcanvas-app-sdk-0.1.0.tgz
cd my-app
npm install
npm run build
```

The output is `dist/app.shellcanvas.json`. Open ShellCanvas's **Apps → Install app**, select it, review the permissions and open the app. No desktop rebuild/restart is needed. For an update, change the manifest version and rebuild. Existing windows keep their code and grants until closed; a new window uses the installed version.

The generator requires a new directory and never overwrites an existing project. Until publication, pass `--sdk` to point the generated dependency at the local tarball. `shellcanvas-app build [directory] --version 0.2.0` overrides the artifact's version without editing the manifest. `shellcanvas-app validate <package>` invokes the same package parser used by the desktop.

## Public API

```ts
import { connectToShellCanvas, RpcError } from "@shellcanvas/app-sdk";

const desktop = await connectToShellCanvas();
try {
  const answer = await desktop.system.dialogs.messageBox({
    title: "Continue?",
    message: "Choose what to do with your note.",
    buttons: [
      { id: "continue", label: "Continue" },
      { id: "cancel", label: "Cancel" },
    ],
    defaultId: "continue",
    cancelId: "cancel",
  });
} catch (error) {
  if (error instanceof RpcError) console.error(error.code, error.message);
}
```

| Service                | API                                                                                 | Required grants                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Shared message box     | `system.dialogs.messageBox(options, {signal}?)`                                     | `system.dialogs`                                                                            |
| Open/Save selection    | `system.dialogs.openFile(options?, control?)`, `saveFile(options?, control?)`       | `system.dialogs`, `files.read`                                                              |
| Save text workflow     | `system.files.saveTextAs({text, name?, directory?, allowReplace?}, control?)`       | `system.dialogs`, `files.read`, `files.create`; replacement additionally needs `files.edit` |
| Own window state       | `window.setDocumentState({dirty, busy, title?})`, `window.getState(signal?)`        | Intrinsic to this app window                                                                |
| Window actions         | `window.focus`, `minimize`, `maximize`, `restore`, `requestClose` (optional signal) | Intrinsic; active workspace only                                                            |
| Local data/preferences | `storage` and `settings`: `get`, `put`, `remove`, `list`                            | `system.storage`                                                                            |
| Environment/discovery  | `environment.get(signal?)`, `services.list(signal?)`                                | Intrinsic; individual methods still enforce their grants                                    |
| State events           | `events.subscribe(listener, onError?)` returns an unsubscribe function              | Intrinsic; event contents are filtered by the host                                          |
| Text clipboard         | `clipboard.readText(signal?)`, `writeText(text, signal?)`                           | `system.clipboard.read` or `system.clipboard.write`                                         |
| Custom device services | `services.call(method, params?, signal?)`                                           | `services.<service-id>` for the selected adapter service                                    |

All methods are asynchronous except subscription disposal. `connectToShellCanvas(timeoutMs?)` must run inside a desktop-owned app frame. `dispose()` closes the instance channel; page teardown does this automatically. Named types, `Json`, `RpcCode` and `RpcError` are exported from the package root. Manifest parsers/types are available from `@shellcanvas/app-sdk/package`.

Window actions affect only the calling window in the active workspace. `getState()`
returns visibility, focus, layout mode and `canMaximize`; maximize is unavailable
in compact layouts. Restore clears tiling/maximization and restores visibility.
`requestClose()` uses normal busy/draft protection. Its reply acknowledges a
request, not completed closure or user consent to discard. Save before requesting
close: the app and channel may disappear before a reply or continuation executes.
Cancellation cannot undo an already accepted window action.

Image clipboard methods are `clipboard.readImage(signal?)` and
`clipboard.writeImage({width, height, rgba}, signal?)`. `rgba` is a `Uint8Array`
with four bytes per pixel in top-to-bottom row order. They require separate
`system.clipboard.image.read` / `system.clipboard.image.write` grants; text grants
never authorize image access. Use service discovery for availability. The broker
streams 32 KiB chunks and publishes only a complete image. Reads and writes capture
their pixels, so subsequent caller/clipboard changes do not alter an in-progress
snapshot. Dimensions must match the exact byte count. Images need memory for their
pixels; there is no application-specific total-image cap. Cancellation cannot undo
native publication; inspect uncertain outcomes before retrying. File/custom-format
clipboard publication and mobile image support are not provided by this API.

`clipboard.pasteFiles({ binding, path }, signal?)` prepares native clipboard files
and folders for upload or same-workspace remote copy. It requires
`system.clipboard.files.read` and the corresponding `files.upload` or `files.copy`
grant. The returned array contains owned transfer handles; preparation
does not start them. Call `run`, inspect the result, and `close` each handle using
the transfer API. Empty/non-file clipboard contents return an empty array.
Windows Explorer file-list input and this process's own remote clipboard selections
are supported; other platforms and foreign virtual-file inputs are unavailable.
A locally cut selection uploads a copy and keeps its
source. Native file paths are not returned in ticket fields. Large selections
share one job; contents stream natively and folders use disk-backed discovery.
Pending native preparation remains busy until it returns, even after cancellation.
`clipboard.copyFiles(entries, signal?)` exports remote `{ binding, path, revision }`
entries to the Windows clipboard. Declare `system.clipboard.files.write` and
`files.download`. References must use one accepted binding and current revisions.
The SDK snapshots and chunks root metadata; native code discovers folders and
streams contents only when Explorer requests them. Keep the desktop and source
connection open until external Paste finishes. Copy completion means publication,
not a completed destination transfer. Cancellation cannot retract a publication
already dispatched to the OS; do not retry uncertain results automatically.
Pending native preparation remains host-enforced busy work, independently of an
app's reported document state. Remote Copy selections are shared between installed
apps and bundled Files in the original workspace. Another workspace or replaced
file-service connection is refused. The SDK captures and checks the clipboard
version before preparation; it never falls back to another transfer permission.
Public Cut, cross-process selection sharing and custom formats remain follow-ups.

`call(method, params?, signal?)` uses the explicit broker method map and permission checks. It is not a native-command escape hatch. Use `services.call` for custom adapter methods. Discover methods first; `granted` and `available` are separate. Custom entries include the advertised service version and an opaque `source` identity. Declare `services.acme.sensor` to request access to a selected `acme.sensor` service; all its advertised methods share that grant. The app never supplies a native session or source ID. Custom JSON result validation belongs to the app and adapter contract.

## Ownership, cancellation and errors

`hostSettings.read({binding}, signal?)` requires `host.settings.read` and returns provider-defined `RemoteHostSetting` fields. `hostSettings.apply(field, value, signal?)` requires `host.settings.write`, submits the captured binding/ID/revision, and returns confirmed state. This is separate from local `settings` storage. Render field labels, choices, read-only reasons and nullable revisions; check both method permission/availability and field writability. Apps own proposal/review UI, while the provider checks values, revisions and account access. Source changes refuse old settings and late results. A canceled request can leave a native write running; the desktop holds its busy guard until that write settles. One read and one apply may be outstanding per window, including canceled native work. Keep proposals and refresh after uncertain failures; writes are never retried automatically.

`transfers.upload(destination, {folder?: boolean}?, signal?)`, `download(entry, signal?)`, `downloadMany(entries, signal?)` and `copy(entry, destination, signal?)` prepare window-owned jobs. Grants are `files.upload`, `files.download` and `files.copy` respectively. Locations include the accepted binding; entries include a directory revision. Upload/download uses native local choosers. Folder upload also needs device folder capability. Dismissal returns an empty array or `null` for single download.

A transfer handle provides `run(signal?)`, `status()`, `watch(signal?)`, `cancel()` and `close()`. Preparation does not start bytes; `run` starts once and reports the actual completed/canceled/failed result. Canceling a running job is a request, so a late successful publication still reports completion. A failed cancellation remains retryable and keeps the window busy. `close` waits for cleanup/outcome. Progress snapshots coalesce; stopping observation does not cancel the transfer. File bytes and native IDs remain outside the app, and local download paths are omitted. Source changes cannot retarget a handle. The desktop automatically guards unfinished transfers even if the app reports `busy: false`. Release finished handles; a window may retain 32 jobs and one pending chooser. Native selection currently accepts up to 16 roots; descendants use the streaming tree engine without a fixed depth/count cap.

`console.open({binding, cols?, rows?}, signal?)` requires `system.console` and returns a window-owned byte channel with `read`, `write`, `resize`, `close`, and `resizable`. `read()` returns up to 64 KiB or `null` at EOF; `write(Uint8Array | string)` sends bytes or UTF-8 text in chunks. Read and write concurrently. Await writes; only one read and one write may be pending per console. Output is backpressured until consumed, with no total stream-size limit. A window may own 16 consoles, including pending opens and cleanup. Fixed-size consoles retain I/O but reject resize.

Close consoles in `finally`. The optional opening signal controls the console lifetime; aborting an individual operation also closes it because bytes may already have crossed the boundary. Never retry uncertain input automatically. Connection changes retire old handles; acceptance requires opening a new console. Native handles are not exposed. Closing one console preserves others on the same connection.

Enable each remote action using both `granted` and `available` from service discovery, and refresh after `system.services` or `system.environment` events. A device can support browsing without text documents: `files.read` alone does not establish `system.files.readText` availability. The optional environment `operations` map narrows capability support; missing lists retain the legacy contract. Read-only text access does not require edit/create permission. Keep drafts when a service disappears, and discard stale discovery replies after a newer refresh starts.

File actions use directory-entry revisions: `files.makeDirectory({binding, parent, name}, signal?)`, `renameEntry({binding, path, revision}, name, signal?)`, `moveEntry(entry, {binding, path}, signal?)` and `removeEntry(entry, signal?)`. Moving requires `files.move`; the other three require `files.manage`. Source and destination bindings must match. Creation/rename/move return an opaque `RemoteFileLocation`; refresh the listing for a new revision afterward. These methods refuse replacement and do not implement recursive deletion or cross-host moves. They do not display confirmation dialogs; use shared dialogs in the app's workflow. A directory-entry revision is not interchangeable with a text-document revision.

`files.list({binding, path?}, signal?)` is an async iterable of directory pages. Omit `path` for the provider default. Each page includes opaque parent/home/roots, entries and its binding. Use `for await`; breaking the loop or aborting releases the listing, and connection changes retire old iterators. Pages are bounded, with no total entry-count limit. The current backend materializes a directory before delivery; the public iterator can support incremental providers. A window may retain up to 16 simultaneous listings; close unused iterators before opening more.

For remote text, capture `environment.get().binding` before opening a file picker, then pass `{binding, path}` to `files.readText`. Keep the returned `RemoteTextDocument` alongside the draft and pass it unchanged to `files.saveText(document, newText)`. The snapshot includes the exact binding and revision; old snapshots are rejected after connection replacement. Never substitute a fresh binding/revision to force a save. `files.createText({binding, parent, name, text}, signal?)` creates only and requires `files.create`; reading needs `files.read`, saving needs `files.edit`. Use `system.files.saveTextAs` for reviewed replacement. These methods accept an optional AbortSignal. Text service size limits apply; binary and folder transfers are separate APIs still under development.

Each client belongs to one window, package/grant generation and explicitly accepted workspace binding. It cannot choose another window or native session ID. Reconnect can require explicit user approval before old app windows use a new connection. Preserve drafts while waiting; observe `system.environment` events for connection/visibility changes. Event batches with `reset: true` are current snapshots rather than a complete historical replay.

Use `AbortSignal` for cancelable calls. Closing the instance rejects pending calls and releases resources. Cancellation cannot undo a dispatched write. Do not automatically retry failed writes, saves or clipboard publication. Report dirty/busy state so the desktop can review close and quit requests. Mark a draft clean only if the saved snapshot still matches the editor contents.

Storage is local to the app identity and survives package updates/removal. `put(key, value, null)` creates only; replacement requires the revision returned by `get`/`put`. A revision conflict must be reviewed or reloaded, not blindly retried. `list({after, limit})` is paginated live state. Storage is not a credential vault. File locations are opaque provider values: do not split, join or translate them. Open/Save selections do not themselves write data or authorize overwriting.

| Error code    | Meaning and response                                                                  |
| ------------- | ------------------------------------------------------------------------------------- |
| `invalid`     | Fix the request shape or unsupported option.                                          |
| `denied`      | Required permission is absent; explain which feature needs it.                        |
| `unavailable` | The service or current connection does not support the action.                        |
| `closed`      | The owning channel/window/binding has retired.                                        |
| `aborted`     | The call was canceled; dispatched effects may still have occurred.                    |
| `busy`        | Resource or concurrency capacity is occupied; avoid unbounded queues.                 |
| `failed`      | The operation failed; preserve work and inspect the result before retrying mutations. |

User dismissal normally returns `null` from dialogs and save workflows. Host-originated failures use `RpcError`; handshake failures can be ordinary errors. Type declarations describe the supported API, not additional authority.

## Package and compatibility

Edit `main.ts`, `style.css` and `shellcanvas.json`. The bundled schemas describe the source manifest and executable package. Source manifests may contain `$schema` for editor completion; packaging removes it. The desktop enforces additional resource bounds: 16 Mi UTF-16 units for a package and 100 UTF-16 units for a title. These are app metadata/control limits, not remote file-tree limits.

All JavaScript must be bundled. External assets, runtime imports, networking, native Tauri IPC and Node APIs are unavailable in UI app frames. Use provider-owned desktop services for remote access. Native adapters are separate, explicitly trusted executable packages.

The client uses app channel v1 and format-1 packages. Discover optional methods instead of assuming every host has them. Version 0.x APIs remain subject to change; pin the SDK and test against the target desktop. This package does not claim a stable future ABI, a marketplace, non-Windows native isolation or complete virtual-OS coverage.
