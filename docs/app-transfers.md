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

| Method                                              | Permission                                                                      | Result                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------- |
| `upload(destination, {folder?: boolean}?, signal?)` | `files.upload`                                                                  | Jobs for the selected local files or folder |
| `download(entry, signal?)`                          | `files.download`                                                                | One job, or `null`                          |
| `downloadMany(entries, signal?)`                    | `files.download`                                                                | Jobs sharing one chosen local destination   |
| `copy(entry, destination, signal?)`                 | `files.copy`                                                                    | One remote copy job                         |
| `pasteClipboard(destination, signal?)`              | `system.clipboard.files.read` plus `files.upload`, `files.copy` or `files.move` | Owned jobs matching the clipboard intent    |

Clipboard Cut paste returns one move job, using the original provider's move service.
It does not require transfer capabilities. Canceling before dispatch releases its
reservation; a dispatched move awaits the provider's result and cannot be replayed.
See [clipboard ownership and remaining limitations](app-clipboard.md).

Folder upload additionally requires the device's `files.folders` capability. Capability support does not grant additional permissions. Discover the preparation method's `granted` and `available` state before enabling it. Native multiple-selection uploads and downloads use one disk-backed catalog and one batch job, without a fixed root-count or tree-entry/depth cap. The returned array describes jobs, not individual selected files; do not zip it with the input entries. Files open sequentially within the batch, and progress aggregates their bytes. Root names and existing download destinations are checked before writing. A later failure or cancellation preserves completed items and reports the incomplete batch.

## Progress and cancellation

A handle exposes `binding`, `name`, `size`, `direction`, `run`, `status`, `watch`, `cancel` and `close`. `run()` starts once; repeated calls share the same execution. A resolved run returns `completed`, `canceled` or `failed`, byte totals, and an optional message. Completed remote destinations may include an opaque location; downloaded local paths are omitted. An invalid start or closed handle rejects with `RpcError`.

`status()` returns the current revision and snapshot. `watch(signal?)` is an async iterable of coalesced snapshots, ending after the final result. It can skip intermediate progress; it is not a durable event log. Stop a pending watch with its signal. Breaking a `for await` loop stops observation only, not the transfer. Immediate status reads remain available alongside a waiting watcher.

`cancel()` acknowledges a cancellation request. It is not proof that a running operation stopped before publication. `run(signal)` requests cancellation when the signal aborts and waits for the authoritative outcome. If publication wins the race, completion is preserved. `close()` cancels unfinished work, waits for the running result, then releases ownership. A cancellation failure remains visible as `cancel-failed`; retry cancellation or close explicitly. The host will not start an unwanted queued job after cancellation failure or retry uncertain writes automatically.

A move blocked before dispatch can fail to release its prepared native reservation.
In that case `run()` returns the failed operation, but `status()` stays `cancel-failed`
without a terminal `result` and the desktop remains busy. The ticket permits cleanup
only. Retry `cancel()` or `close()`; a successful cleanup publishes the failed result
to watchers and releases the guard. Closing an app does not discard this retained
ownership: the host can retry cleanup. An earlier concurrent cancellation does not
let Close skip a cleanup failure discovered later by the blocked start.

Prepare signals cancel pending selection ownership. A native chooser can finish later; its returned tickets are canceled without starting. If releasing those unseen tickets fails, the desktop displays **Retry transfer cleanup** and retains the busy guard until cleanup succeeds. Retrying cleanup never starts the transfer. One chooser may be pending per window. Up to 32 retained jobs/preparation groups are allowed per window; the native engine also limits queued/running tickets and concurrent streams. Release finished handles promptly. These bounds limit simultaneous resources, not total file bytes or tree size.

The desktop marks a window busy while it owns a pending chooser or an unfinished job. Calling `window.setDocumentState({dirty: false, busy: false})` cannot clear this host-owned state. Window/workspace/quit guards remain active until work finishes or queued cancellation succeeds. Source changes cancel old jobs; retained handles cannot retarget another host. Window retirement initiates cleanup even when an app neglects to close its handles.

## Verification scope

`src/extensions/transfer-bridge.test.ts` tests the actual SDK/RPC path for preparation without execution, permissions, binding checks, hidden native IDs/local paths, folder capability loss, progress, cancellation races, late chooser cleanup, foreign handles, failed cancellation retry and source retirement.

The Windows installed-app desktop fixture passes 88 checks at both 1360×900 and 800×900. It includes a separately built SDK client, injected host transfer services, folder/multiple download selection, cancellation followed by late completion, mandatory busy/quit guards, and host recovery after failed cleanup of unseen tickets. Cut checks additionally cover bundled Files into an installed app, move-grant denial, retained reservations, failed close and cleanup retry in both app and bundled UI. It does not open an OS chooser or transfer live host data. The native transfer engine has separate evidence in [transfers.md](transfers.md).
