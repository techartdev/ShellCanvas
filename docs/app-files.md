# Runtime app file services

Installed apps can read, create and revision-check text documents through `client.files`. These are brokered workspace operations; apps do not receive native session IDs, credentials or local filesystem access. Read, edit and create require `files.read`, `files.edit` and `files.create` respectively. Current capability availability is checked separately from permission.

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

This API uses the existing bounded text-document service. It does not replace the streaming binary/folder transfer engine or impose a file-tree count limit. Public directory browsing, file mutations, terminal streams and transfers remain separate SDK deliverables. Installed process adapters still need their text/mutation bridges before they can advertise these capabilities.

## Verification

The file bridge tests drive the public client through the actual RPC implementation. They cover Unicode/opaque locations, unchanged revision snapshots, separate grants, invalid native-ID injection, stale bindings, late replies, conflict refusal and cancellation around writes. The Windows desktop probe additionally exercises the installed SDK artifact inside its isolated frame with synthetic file services, including reconnect and denied permissions. See [SDK verification](app-sdk.md#verification) for the packed-SDK build and native fixture commands.
