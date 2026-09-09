# Runtime app transfers

Installed apps use `client.transfers` to prepare uploads, downloads and remote copies through the native transfer engine. Apps receive window-owned job handles; file contents, native ticket IDs and local destination paths do not cross the app channel. This API uses the existing [transfer guarantees](transfers.md), including streaming folder contents and disk-backed tree metadata.

## Prepare, run and release

```ts
const client = await connectToShellCanvas();
const binding = (await client.environment.get()).binding;
if (!binding) throw new Error("Connect a file source first");

// Use provider-owned locations obtained from a directory listing or picker.
const job = await client.transfers.copy(
  { binding, path: selected.path, revision: selected.revision },
  { binding, path: destination.path },
);
try {
  const result = await job.run(cancelController.signal);
  if (result.status !== "completed") showTransferResult(result);
} finally {
  await job.close();
}
```

Preparing does not start copying bytes. Upload/download preparation invokes a native local chooser. A dismissed upload or multi-download chooser returns `[]`; a dismissed single download returns `null`. Remote copy needs no local chooser. Every request includes the app window's accepted binding; copy source and destination must share it. Entry revisions come from the directory service, not from text-document revisions.

| Method                                              | Permission       | Result                                      |
| --------------------------------------------------- | ---------------- | ------------------------------------------- |
| `upload(destination, {folder?: boolean}?, signal?)` | `files.upload`   | Jobs for the selected local files or folder |
| `download(entry, signal?)`                          | `files.download` | One job, or `null`                          |
| `downloadMany(entries, signal?)`                    | `files.download` | Jobs sharing one chosen local destination   |
| `copy(entry, destination, signal?)`                 | `files.copy`     | One remote copy job                         |

Folder upload additionally requires the device's `files.folders` capability. Capability support does not grant additional permissions. Discover the preparation method's `granted` and `available` state before enabling it. The current native multiple-selection flow accepts up to 16 roots; this is distinct from the number or depth of descendants inside a folder. There is no fixed tree-entry/depth cap in the folder transfer engine.

## Progress and cancellation

A handle exposes `binding`, `name`, `size`, `direction`, `run`, `status`, `watch`, `cancel` and `close`. `run()` starts once; repeated calls share the same execution. A resolved run returns `completed`, `canceled` or `failed`, byte totals, and an optional message. Completed remote destinations may include an opaque location; downloaded local paths are omitted. An invalid start or closed handle rejects with `RpcError`.

`status()` returns the current revision and snapshot. `watch(signal?)` is an async iterable of coalesced snapshots, ending after the final result. It can skip intermediate progress; it is not a durable event log. Stop a pending watch with its signal. Breaking a `for await` loop stops observation only, not the transfer. Immediate status reads remain available alongside a waiting watcher.

`cancel()` acknowledges a cancellation request. It is not proof that a running operation stopped before publication. `run(signal)` requests cancellation when the signal aborts and waits for the authoritative outcome. If publication wins the race, completion is preserved. `close()` cancels unfinished work, waits for the running result, then releases ownership. A cancellation failure remains visible as `cancel-failed`; retry cancellation or close explicitly. The host will not start an unwanted queued job after cancellation failure or retry uncertain writes automatically.

Prepare signals cancel pending selection ownership. A native chooser can finish later; its returned tickets are canceled without starting. If releasing those unseen tickets fails, the desktop displays **Retry transfer cleanup** and retains the busy guard until cleanup succeeds. Retrying cleanup never starts the transfer. One chooser may be pending per window. Up to 32 retained jobs/preparation groups are allowed per window; the native engine also limits queued/running tickets and concurrent streams. Release finished handles promptly. These bounds limit simultaneous resources, not total file bytes or tree size.

The desktop marks a window busy while it owns a pending chooser or an unfinished job. Calling `window.setDocumentState({dirty: false, busy: false})` cannot clear this host-owned state. Window/workspace/quit guards remain active until work finishes or queued cancellation succeeds. Source changes cancel old jobs; retained handles cannot retarget another host. Window retirement initiates cleanup even when an app neglects to close its handles.

## Verification scope

`src/extensions/transfer-bridge.test.ts` tests the actual SDK/RPC path for preparation without execution, permissions, binding checks, hidden native IDs/local paths, folder capability loss, progress, cancellation races, late chooser cleanup, foreign handles, failed cancellation retry and source retirement.

The Windows installed-app desktop fixture passes 49 checks. It includes a separately built SDK client, injected host transfer services, folder/multiple download selection, cancellation followed by late completion, mandatory busy/quit guards, and host recovery after failed cleanup of unseen tickets. It does not open an OS chooser or transfer live host data. The native transfer engine and bundled Files workflows have separate evidence in [transfers.md](transfers.md).
