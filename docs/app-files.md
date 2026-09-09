# Runtime app file services

Installed apps can read, create and revision-check text documents through `client.files`. These are brokered workspace operations; apps do not receive native session IDs, credentials or local filesystem access. Read, edit and create require `files.read`, `files.edit` and `files.create` respectively. Current capability availability is checked separately from permission.

File browsing does not imply text-document access. Check that discovery reports `system.files.readText` as both `granted` and `available` before offering an editor action, and refresh on service/environment events. Operation metadata narrows `files.read` for limited providers; read-only text access does not require edit/create support. Existing drafts remain local when text access disappears. Calls still validate availability because it can change after discovery.

```ts
import {
  connectToShellCanvas,
  type RemoteTextDocument,
} from "@shellcanvas/app-sdk";
const desktop = await connectToShellCanvas();
const { binding } = await desktop.environment.get();
if (!binding) throw new Error("Connect to a workspace first.");
const selected = await desktop.system.dialogs.openFile({
  extensions: [".txt", ".md"],
});
let document: RemoteTextDocument | undefined;
if (selected?.length) {
  document = await desktop.files.readText({ binding, path: selected[0].path });
  // Keep this complete snapshot alongside the draft.
  document = await desktop.files.saveText(
    document,
    document.text + "\nA note.",
  );
}
```

Capture the binding **before** choosing a location. The broker compares it with this window's explicitly accepted binding. A delayed selection or retained document cannot be silently redirected after reconnect. `saveText` sends the snapshot's path, binding and exact reviewed revision. Never replace those fields with a new environment binding or revision to bypass a conflict. Preserve the draft and ask the user to reopen or use Save As on the intended connection.

`createText({binding, parent, name, text}, signal?)` creates a new text file and never authorizes replacement. Use the shared Save picker to obtain an opaque parent and a name. If the picker reports an existing destination, use the existing `system.files.saveTextAs` workflow for explicit replacement review, or decline the destination. Provider paths and parent locations must not be parsed, joined or normalized by the app.

The returned `RemoteTextDocument` contains the provider's text, name, path, parent, revision and writable flag, plus the app window's opaque binding. It is a value snapshot, not an open OS file handle, and needs no release call. `writable` is informative; permissions, source availability and provider checks still govern writes. A successful save returns a new revision; only mark a draft clean if its contents still match the saved text.

Calls accept an optional `AbortSignal`. Cancellation before dispatch prevents work; cancellation or source replacement after dispatch suppresses late results but cannot undo a provider write already issued. The existing native text methods do not have interruptible byte streaming. Do not retry mutations automatically after cancellation, failure or uncertain completion. Provider error messages are returned as `failed`; structured conflict categories remain part of the error-contract consolidation work.

Text operations use the existing bounded text-document service. They do not replace the streaming binary/folder transfer engine or impose a file-tree count limit. Terminal streams and transfers remain separate SDK deliverables. Installed process adapters still need their text/mutation bridges before they can advertise these capabilities.

## File actions

| Operation       | Arguments                                                                   | Grant          |
| --------------- | --------------------------------------------------------------------------- | -------------- |
| `makeDirectory` | `{binding, parent, name}`, optional signal                                  | `files.manage` |
| `renameEntry`   | `{binding, path, revision}`, new name, optional signal                      | `files.manage` |
| `moveEntry`     | `{binding, path, revision}`, destination `{binding, path}`, optional signal | `files.move`   |
| `removeEntry`   | `{binding, path, revision}`, optional signal                                | `files.manage` |

Use the **directory entry revision**, not a text-document revision. When the provider does not supply an entry revision, keep these actions unavailable. Creation, rename and move return a `RemoteFileLocation` with the provider's resulting path and the original binding. Refresh the affected directory to get a current entry revision before another mutation; do not reuse the old revision or construct destination paths yourself.

Moves remain within one accepted binding. The broker rejects a destination from another binding before dispatch. The provider preserves the item's name, validates the destination and refuses replacement. These methods do not implement cross-host moves, recursive deletion or overwrite. The SSH implementation deletes files, links and empty folders; it does not follow links when deleting. Provider validation and source ownership apply to every call.

These are low-level operations and do not open dialogs themselves. An app should present the intended action and use `system.dialogs.messageBox` for its delete/discard confirmation. Selecting a destination does not grant permission or waive conflict checks. No failed mutation is retried automatically. A cancellation after dispatch may have effects, so preserve the UI state and inspect before attempting another operation.

```ts
// entry is from a directory page; keep that page's binding with it.
if (!entry.revision)
  throw new Error("This provider cannot validate file changes.");
const renamed = await desktop.files.renameEntry(
  { binding: page.binding, path: entry.path, revision: entry.revision },
  "renamed.txt",
);
// renamed.path is provider-owned. Refresh the parent before further actions.
```

The existing session service handles relocation notifications for bundled Files/Editor windows. The public API returns the new location to the calling app; other installed app documents are not automatically rewritten or reloaded after a relocation. Their old snapshots remain subject to revision checks.

## Directory browsing

```ts
const { binding } = await desktop.environment.get();
if (!binding) throw new Error("Connect to a workspace first.");
for await (const page of desktop.files.list({ binding })) {
  // Omitting path asks for the provider's default directory.
  console.log(page.name, page.parent, page.home, page.roots);
  for (const entry of page.entries) {
    console.log(entry.name, { binding: page.binding, path: entry.path });
  }
}
```

`files.list({binding, path?}, signal?)` yields `RemoteDirectoryPage` values. Each page repeats navigation metadata and contains up to 128 entries. Empty directories still yield one page so their roots/home/parent remain usable. Retain the page's binding with its locations; navigate using those opaque tokens, not string manipulation. A new iteration opens a new scan; it is not a live watcher. Ordering and consistency during concurrent remote changes belong to the provider; a scan is not guaranteed to be an atomic snapshot.

The SDK owns the listing ID and sends cleanup when the loop ends, breaks or throws. Aborting also closes the host reader while consumer code is paused between pages. Disconnect, source replacement and closing the owning frame retire its listings. Closing is allowed even when read access becomes unavailable. Do not manually retain an iterator indefinitely; use `for await`, or call `return()` when abandoning it.

Pages stay within a 1 MiB UTF-8 control-message envelope, including unusually long names. There is no total entry-count or depth cap. Each app window can retain 16 simultaneous listings; additional starts return `busy` until capacity becomes available. The native desktop also bounds active readers to 32 across windows. Cancellation retires the scan, but native capacity stays charged until cleanup completes; unconfirmed cleanup stays charged until the original physical source disconnects. These are resource-concurrency limits, not limits on the size of a directory. An individual entry or navigation-metadata block exceeding the page envelope fails explicitly instead of truncating data.

Production SSH and installed adapter listings now reach this iterator through demand-driven native readers. The broker buffers one provider page and does not read ahead. Legacy providers and preview services without a reader still use a materialized compatibility snapshot. Bundled Files and system pickers have not yet migrated to the reader contract. See [native directory readers](native-directory-readers.md) for lifecycle and cancellation rules; recursive folder transfers use their separate incremental engine.

## Verification

The file bridge tests drive the public client through the actual RPC implementation. They cover Unicode/opaque locations, unchanged revision snapshots, separate grants, invalid native-ID injection, stale bindings, late replies, conflict refusal and cancellation around writes. Directory tests cover 50,000 entries, stable snapshots, empty-directory navigation, large names, early break, paused cancellation, owner/source retirement and resource-capacity recovery. The Windows desktop probe additionally exercises the installed SDK artifact inside its isolated frame with synthetic file services, including multi-page listings, reconnect and denied permissions. See [SDK verification](app-sdk.md#verification) for the packed-SDK build and native fixture commands.
