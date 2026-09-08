# App data and settings

Runtime apps can declare `system.storage` to use `client.storage` and `client.settings`. Installation reviews label this permission **This app’s local data and settings**. The host binds both services to the installed app identity; requests cannot select a different app, host, database or directory. Data and settings are separate namespaces.

Values live in the desktop's local IndexedDB database, separate from host profiles, credentials and installed packages. They survive connection changes and app updates. All windows and versions with the same app ID share their committed values. Removing a package preserves its data; a future reinstall of that identity can access it after storage permission is approved. Package identity is not publisher authentication, so review updates/reinstalls as code that can access that app's existing data.

## API

```ts
const client = await connectToShellCanvas();
const previous = await client.settings.get("editor");
const saved = await client.settings.put(
  "editor",
  { format: 1, wrap: true },
  previous?.revision ?? null,
);
await client.settings.remove("editor", saved.revision);

let after: string | undefined;
do {
  const page = await client.storage.list({ after, limit: 100 });
  for (const key of page.keys) {
    const entry = await client.storage.get(key);
    // A different window may have removed the key since listing.
    if (entry) console.log(key, entry.value);
  }
  after = page.next ?? undefined;
} while (after);
```

Both namespaces expose `get`, `put`, `remove` and `list`. `get` returns `{ value, revision }` or `null`. Values are JSON, including JSON `null`; missing data is distinguished by the outer result. An `AbortSignal` is the optional final argument to each method.

`put` and `remove` require a revision. `null` means the key must be absent; a string must match the last read revision. The host checks that precondition and performs the change in one read/write transaction, including when separate desktop database connections write concurrently. A mismatch returns `RpcError` with code `busy`. Read the new value and ask the user to reconcile meaningful changes; do not automatically repeat a stale write with a fresh revision. A deleted/recreated value receives a new revision, so an old writer cannot overwrite it.

Apps own their data schema. Include a format/version inside values and migrate with the same revision precondition. An older app version should preserve values it does not understand. The Field Notes example stores `{ format: 1, text }` and refuses to restore an unknown format. Remembering locally does not mark its remote-file draft saved. Restoring over unsaved edits requires confirmation.

## Bounds and lifecycle

- Keys contain 1–256 characters, excluding NUL. They are opaque keys, not filesystem paths. Special property names and Unicode are valid.
- Each value is limited to 1 Mi UTF-16 units of JSON. This service is for settings and small app records; use file/stream services for documents and bulk data. It does not limit remote folder size or depth.
- Lists return up to 200 keys per page (100 by default). `next` is the next request's exclusive `after` cursor. Pages reflect live committed state, not a frozen multi-page snapshot. Listing does not load all stored values into memory.
- The browser/WebView storage quota still applies. Failures are reported; the host does not replace a failing database with an empty one. This is local persistence, not a backup, secret store or cross-device sync service.
- Closing the app closes its RPC channel and aborts pending storage transactions where still possible. Canceling after commit cannot undo the write; reread to resolve an uncertain outcome and never blindly retry.

The implementation uses [IndexedDB's transaction and key-order model](https://www.w3.org/TR/IndexedDB-3/). It does not promise survival of operating-system crashes or power loss beyond that storage implementation's durability guarantees.

## Evidence and development

`npm test -- src/extensions/app-storage.test.ts` checks host-owned identity binding, namespace separation, argument validation, permissions and channel-close cancellation. The desktop integration fixture exercises the public client through its opaque frame, plus real IndexedDB connections for concurrent writes, stale deletion, canceled writes and Unicode key pagination. It also remembers a note in one app version, restores it in another and checks that package removal leaves it available before cleaning up the fixture data. These are synthetic local records, with no real remote writes.

Build Field Notes with `node scripts/pack-app.mjs examples/dialog-app` and install its package through the desktop's Apps manager. Its **Remember locally** and **Restore local note** actions use only the public client. The older dialog-only workbench does not supply storage and disables those two actions. Desktop preview and native WebViews have separate origins; test fixtures also use separate database names.

The browser restart walkthrough uses `/tests/fixtures/native-desktop-probe.html?persistence=write`. After its `remembered-for-page-close` result, close the sample window and the entire page. Open a new page at the same path with `?persistence=read`. It restores the exact note before continuing through the full integration sequence and cleanup. This verifies persistence across document teardown, rather than reading from an in-memory app instance. Native operating-system restart and power-loss recovery are outside this walkthrough.
