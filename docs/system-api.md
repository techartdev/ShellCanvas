# App system API

API version 1. Bundled apps receive these shared services as `context.system`;
installed apps obtain them from `client.system` after `connectToShellCanvas()`.
Use the [standalone app guide](app-sdk.md) to create an installed app. The examples
below describe the shared workflows; the `services.readText(path)` example uses
the bundled, workspace-bound service handle. Installed apps use the separate
[public file API](app-files.md), which also captures the accepted workspace binding.
Package loading, grants and the app-frame boundary belong to the
[runtime app layer](runtime-apps.md), not to dialog implementations.

## Dialogs

```ts
const answer = await system.dialogs.messageBox({
  title: "Apply changes?",
  message: "Apply the reviewed settings to this workspace?",
  buttons: [
    { id: "cancel", label: "Keep editing" },
    { id: "apply", label: "Apply" },
  ],
  defaultId: "cancel",
  cancelId: "cancel",
});
if (answer !== "apply") return;

const files = await system.dialogs.openFile({
  title: "Open documents",
  multiple: true,
  extensions: [".txt", ".md"],
});
if (!files) return; // User canceled.
const document = await services.readText(files[0].path);
```

`messageBox` returns the selected button ID. Escape/Close returns `cancelId`, or `null` when it is absent. The default is one OK button. It accepts one to four buttons, an optional `info`/`warning`/`error` kind, and plain text; it never evaluates markup. Dialogs queue across desktop windows and show the owning app's name.

`openFile` returns a readonly selection with opaque provider locations. `kind: "directory"` selects folders and permits choosing the current folder. `directory` supplies an initial location; omission uses the provider's default. Filename suffix filters affect file visibility, never folder navigation. Pickers use the provider's home/roots/parent metadata, so apps do not join or split locations.

```ts
const destination = await system.dialogs.saveFile({
  directory: selectedFolder.path,
  name: "report.json",
});
// destination: { parent, name, existing? } | null
```

`saveFile` selects a destination only. It does not read file contents, create a file, confirm overwrite, or promise that a later write will succeed. `existing` is listing metadata; its revision is not interchangeable with a text-document revision. Use a service's own write contract and explicit replacement workflow. Links, folders and ambiguous names cannot be selected as existing file destinations. Provider-specific filename validation still belongs to the provider.

## Text Save As

```ts
const saved = await system.files.saveTextAs({
  directory: document?.parent ?? undefined,
  name: document?.name ?? "untitled.txt",
  text: draft,
});
if (saved) adoptDocument(saved);
```

This convenience workflow opens the shared Save picker, discovers the destination through the file service, reads an existing text snapshot when replacement is possible, asks for explicit replacement, and writes using the reviewed revision. It never substitutes a new revision after a conflict. A canceled chooser/replacement returns `null`; failures reject and the app retains its draft. Source content is captured when the workflow starts. The bundled Editor uses this API and the shared Open/message-box services.

The operation requires declared and available `files.read` and `files.create`; replacement also requires `files.edit`. The current text service limits and atomicity guarantees still apply. This does not add binary overwrites or silently delete sources.

Set `allowReplace: false` to restrict this invocation to a new destination even when the window can edit files. Runtime brokers additionally clamp this flag to the instance's approved `files.edit` grant; an extension cannot grant itself replacement access by passing `true`.

## Lifetime and errors

All calls accept an optional second argument `{ signal: AbortSignal }`. User cancellation resolves `null` (or a message-box cancel ID). Caller abort, hiding the owning window/workspace, disposal, or session replacement rejects outstanding dialogs. A closed handle cannot be used for new work. File capability access is checked before opening and before delivering a selection. The owning window gets focus; focus returns to the initiating control when the dialog closes.

Bundled calls use `SystemError.code`: `aborted`, `closed`, `unavailable`, `invalid`,
or `busy`. Installed apps receive SDK `RpcError` values; the broker preserves
those system codes, additionally rejects unapproved calls as `denied`, and reports
other service failures as `failed` with their message. See the
[SDK error reference](../packages/app-sdk/README.md). The queue allows 32 pending
dialogs to prevent accidental prompt flooding. This is unrelated to file or directory size.

Cancellation prevents future steps, but cannot roll back a write already dispatched to a remote provider. Retain drafts and inspect the destination after a connection loss during writing; do not automatically retry writes. Window lifecycle, storage, clipboard and custom services are available through the [runtime app SDK](app-sdk.md), with broker-enforced grants. Their remaining integration and platform gates are tracked in the kernel roadmap.

## Verification

- Nine contract tests cover queue ordering/owner isolation, immutable request contents, late replies, AbortSignal, hidden/closed owners, capability loss, selection without file access, replacement confirmation, conflicts, captured drafts, closure during inspection and explicit no-replacement saves. Compound Save As retains its original opener through replacement review; two simultaneous window owners keep separate focus targets.
- `/tests/fixtures/system-api.html` exercises the same window-scoped API without a real host. Browser checks passed multi-selection with suffix filtering, opaque folder navigation, empty-folder selection, revision-checked replacement, default-action focus, Escape and focus restoration.
- The picker was inspected at desktop size and 600 × 800; its navigation, content and actions remain visible. This is responsive-browser evidence, not a native tablet release claim.
- The 2026-09-09 follow-up inspected the Open picker at 800×900, verified suffix-filtered multiple selection and opaque results, Enter-based Save selection, and empty-folder selection. It reproduced and fixed lost opener focus after the replacement review. Both Escape/cancel (no writes) and explicit replacement (the reviewed `text-r1`, returning `text-r2`) now restore the original Save As control. Evidence is retained in `.local/ui-validation/save-as-focus.json` and `compact-open-picker.png`; services are synthetic, with no remote host or OS clipboard access.
- Local native Open/Save selection is exposed through [owned transfer preparation](app-transfers.md); runtime packages and adapter replacement have their own integration guides. These remote location pickers do not expose unrestricted local file handles.
