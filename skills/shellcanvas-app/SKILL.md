---
name: shellcanvas-app
description: Build or extend an installable ShellCanvas desktop app using its public TypeScript SDK and the workspace services a host grants it. Use for community apps and external app projects, not for ordinary changes to the bundled desktop shell.
---

A ShellCanvas app is a sandboxed page that the desktop installs while it is
running. It reaches remote files, terminals, transfers and settings only through
brokered services, and only with permissions the user granted. No desktop
rebuild, no Tauri IPC, no Node runtime in the bundle.

Everything below works from an empty directory. You do not need a ShellCanvas
checkout, and you should not tell the user to clone one.

```sh
mkdir notes-workspace && cd notes-workspace
npm init -y && npm install --save-dev @techartdev/shellcanvas-app-sdk
npx shellcanvas-app init ./notes --id org.example.notes --title "Notes"
cd notes && npm install && npm run build
npx shellcanvas-app validate dist/app.shellcanvas.json
```

`init` refuses to write into an existing directory, so generate a sibling and
work there. The generated project depends on the published SDK; its `npm run
build` type-checks and then packs `dist/app.shellcanvas.json`, which the user
installs through **App Manager → Add apps → Choose package…**.

**One trap worth knowing before you start:** `npx -p @techartdev/shellcanvas-app-sdk shellcanvas-app …`
exits 0 and does nothing. Install the package first and call `npx shellcanvas-app`
(or `node node_modules/@techartdev/shellcanvas-app-sdk/bin/shellcanvas-app.mjs`)
so it resolves locally. If a command produces no output, that is what happened.

Reference: <https://shellcanvas.com/docs/app-sdk/quickstart.html>

## Declare only the permissions the app uses

Permissions are reviewed by a person before installation, so ask for what the
feature needs and nothing more. The manifest's `permissions` array is the whole
request; there is no way to widen it at runtime.

Common grants: `system.dialogs`, `system.storage`, `files.read`, `files.create`,
`files.edit`, `files.manage`, `files.move`, `files.download`, `files.upload`,
`system.console`, `host.settings.read`, `host.settings.write`, `system.network`,
`system.clipboard.read` / `.write`, and `services.<service-id>` for one adapter
service.

Availability and permission are different things, and both must be checked:

```ts
const desktop = await connectToShellCanvas();
const methods = await desktop.services.list();   // one entry per method, not per service
// `granted` is the user's decision; `available` is what this connection offers.
const canOpenText = methods.some(
  m => m.name === "system.files.readText" && m.granted && m.available,
);
```

A capability the host does not provide is not a bug to work around — disable the
action, say why, and keep local work reachable. See
<https://shellcanvas.com/docs/app-sdk/lifecycle.html> and
<https://shellcanvas.com/docs/extensions/permissions.html>.

## Treat locations, revisions and bindings as opaque

Provider values are tokens, not paths, and every remote write is checked against
the revision it was read at. Never parse, join, normalise or regenerate them.

Keep the binding and revision alongside the document you opened, and pass them
back unchanged when saving:

```ts
const { binding } = await desktop.environment.get();
if (!binding) throw new Error("Connect to a workspace first.");
const doc = await desktop.files.readText({ binding, path });
// …user edits…
await desktop.files.saveText(doc, newText);   // the snapshot carries binding + revision
```

Substituting a fresh binding or revision to force a save past a conflict is the
one thing you must never do: it redirects a write to a different host or a file
that changed underneath. A conflict means refresh, show the difference, and let
the user choose. Reconnection retires old snapshots on purpose.

Details: <https://shellcanvas.com/docs/app-sdk/files.html>

## Own every handle, and dispose it with the window

Listings, consoles, transfer jobs, event subscriptions and network responses are
owned by the app window and must be released explicitly. The desktop enforces
per-window caps, so a leak becomes a `busy` failure rather than slow decay.

Caps worth remembering: 16 concurrent listings, 16 consoles, 32 transfer jobs
per window. `events.subscribe` returns an unsubscribe function synchronously;
`dispose()` closes the channel synchronously.

```ts
const stream = await desktop.console.open({ binding });
try {
  await stream.write("show version\r");
  const chunk = await stream.read();      // up to 64 KiB, or null at EOF
} finally {
  await stream.close();                   // always, including on cancellation
}
```

Cancellation is not rollback. An aborted call may already have crossed the
boundary, so inspect the actual state before retrying anything that mutates.
Never retry a write, save or clipboard publication automatically.

More: <https://shellcanvas.com/docs/app-sdk/console.html> and
<https://shellcanvas.com/docs/app-sdk/transfers.html>

## Report document state so the desktop can protect the user

The desktop guards close and quit using what the app reports. If you never call
`setDocumentState`, an unsaved draft can be discarded by an ordinary window
close and the user will blame the app, correctly.

```ts
desktop.window.setDocumentState({ dirty: true, busy: false, title: "notes.md — edited" });
```

Mark clean only when the saved snapshot still matches the editor's contents.
Keep drafts through disconnects, denials, conflicts and uncertain writes — a
failed remote operation is never a reason to drop the user's text. Long
operations should set `busy` so a close is deferred rather than raced.

Window, dialog and storage behaviour:
<https://shellcanvas.com/docs/app-sdk/windows.html>,
<https://shellcanvas.com/docs/app-sdk/dialogs.html>,
<https://shellcanvas.com/docs/app-sdk/storage.html>

## Let the host hold credentials

For an HTTP model or API connection, declare `system.network` and let the
desktop collect and store the secret; the app receives a connection reference
and never sees the key.

```ts
const conn = await desktop.network.configure({ slot: "model", suggestedEndpoint: "https://api.example.com/v1" });
if (!conn) return; // User canceled the trusted desktop form.
const res = await desktop.network.postJSON({ slot: "model", revision: conn.revision, body }, signal);
try { /* read it */ } finally { await res.close(); }
```

Only the configured endpoint is contacted and redirects are rejected. Never put
API keys in app settings, storage, history, manifests or packaged files, and
never ask the user to paste one into your own UI when the host dialog exists.

<https://shellcanvas.com/docs/app-sdk/network.html>

## Verify what you actually built

Package validation, an installed window and real device behaviour are three
separate claims. Prove each one you make, and say which you did not.

```sh
npm run build                                        # type-check and pack
npx shellcanvas-app validate dist/app.shellcanvas.json
```

That establishes the artifact parses and its manifest is legal. It says nothing
about whether the app works. For that, install it and exercise the real path,
including the awkward ones: a missing capability, a denied permission, a
cancelled operation, a reconnect, and closing with unsaved changes.

Use synthetic services unless a real device is part of the authorised task. When
reporting, name the artifact, the platform and which of those paths you actually
ran. Installed third-party app windows are currently a Windows target; see
<https://shellcanvas.com/docs/troubleshooting/compatibility.html>.

## Distribute through GitHub when asked

An app can be installed straight from a repository, with no registry and no
build step on the user's machine.

```sh
npm run build
npx shellcanvas-app repository . --description "Quick notes for your remote hosts."
```

Commit both `dist/app.shellcanvas.json` and the generated root
`shellcanvas.repo.json`, and keep the package bytes exact by adding
`dist/app.shellcanvas.json -text` to `.gitattributes` — a line-ending rewrite
changes the SHA-256 and the install fails the hash check. Users then choose
**App Manager → Add apps → From GitHub**.

Rebuild the package and the descriptor together, every time; a stale descriptor
points at bytes that no longer exist.
<https://shellcanvas.com/docs/extensions/install-apps.html>
