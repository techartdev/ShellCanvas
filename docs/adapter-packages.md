# Runtime connection adapters

The Windows desktop can install a separately compiled native adapter while running. Open **Apps → Connection adapters → Install adapter**, choose the prepared package's `adapter.json`, review its identity and size, and explicitly accept its native-code trust requirement. Installation copies the reviewed bytes into local application data; it does not execute them.

Adapters run with the user's OS permissions. They are different from isolated desktop UI apps and their broker grants. SHA-256 checks detect changed package contents; self-declared hashes do not authenticate a publisher. Install only native programs whose source you trust.

## Connect a workspace

Choose **Connect a host → Use connection adapters**. Select an installed, enabled adapter and complete its configuration fields. A connection may provide both Files and Terminal, or use **Add another connection** to assign those roles to separate adapter processes. Roles are explicit: an unavailable service is disabled rather than silently routed elsewhere.

The bridges provide file browsing/previews and console byte streams, with optional resize. Optional file methods enable text reading/creation/saving, folder creation, rename, move and removal. **Remote settings** is a separate role with provider-defined fields and optional revision-checked changes. Unsupported desktop actions remain unavailable, including transfers until the process transfer bridge is implemented. A device that advertises only files can still open a workspace. Failure to initialize any selected source currently fails the initial composite connection; after connection, source availability is tracked independently.

Adapter connection settings currently survive whole-workspace reconnect in memory. Password fields are excluded and must be entered again. Reconnect preserves the desktop windows and creates fresh native session/console handles. It can use the currently installed version of the same adapter, while preserving the original service assignments and non-secret configuration. Persistent adapter profiles and combining the built-in SSH connector with an installed adapter remain future work. The existing saved SSH profiles continue to use their own connection flow.

## Replace one connection

Open the top workspace selector and choose **Replace … connection** under Current connections. Choose an installed adapter and its configuration, then **Replace connection**. This replaces all service families assigned to that source and keeps the other sources running. Assignments stay fixed; the replacement may provide fewer capabilities, in which case the corresponding actions become unavailable. Active file operations must finish before opening this flow. If the whole workspace has disconnected and released its native session, use Reconnect host instead.

The candidate is prepared before commit. Invalid or canceled preparation leaves the current workspace intact. Commit checks the captured source identity, retires its old handles and advances the workspace's source revision. Cancellation after commit cannot undo the replacement or disconnect unrelated sources. A cleanup failure is reported as a warning after the new connection has been applied. The dialog stays open while cancellation is being resolved.

Files starts at the new provider's root. Editor retains its draft and undo history but requires Open or Save As to attach a document to the new connection. Unaffected Terminal windows retain their existing console. Affected installed apps keep their frame and draft and display **Use reconnected host** before receiving access to the replacement. Custom-service discovery uses captured source identities, so it cannot silently grant new method bindings between native commit and frontend acceptance. Earlier status polls cannot roll back the new revision. Replacement settings update the workspace's in-memory reconnect profile and omit passwords.

## Prepare a practice package

The repository supplies a synthetic adapter with paged files and an echo console. Enable **Text, file changes and settings** in its connection configuration to expose the optional methods, and select the **Remote settings** role to bind its fields. It uses no remote host or real protocol credentials. From the repository root on Windows:

```powershell
cargo build -p shellcanvas-adapter-runtime --bin fixture-adapter --locked
node scripts/pack-adapter.mjs examples/fixture-adapter/adapter.json target/debug/fixture-adapter.exe .local/practice-adapter-package
```

Choose `.local/practice-adapter-package/adapter.json` in the installer. The output directory must not already exist; use a fresh directory when producing another package. The helper copies declared assets, computes their sizes/hashes, expands `platform: "current"` and `{exe}`, and writes the installable manifest last. A failed packaging attempt may leave an incomplete output directory.

## Manifest and catalog

Installable manifests use schema version 1 and contain `id`, `name`, semantic `version`, `description`, exact `platform` (for example `windows-x86_64`), `entrypoint`, optional `arguments`, declared `files`, and optional `configuration`. Each file specifies a relative `path`, byte `size`, lowercase SHA-256 `sha256`, and optional `executable` flag. The entrypoint must be declared executable. Configuration fields contain `id`, `label`, `kind` (`text`, `password`, `number`, or `boolean`), optional `required`, and an optional typed `default`. Password defaults are forbidden. Unknown configuration keys and invalid types are rejected before launch.

The installer rejects links, escaping paths, case aliases and reserved Windows names. Metadata has a 1 MiB parsing bound. Asset copying and hashing use 64 KiB chunks; there is no arbitrary total payload or file-tree entry limit. Review captures a staged snapshot, so changing the original folder cannot change the package being approved. Review requests are window-owned, cancelable, single-use and expire after ten minutes.

The catalog lives under Tauri's local application-data directory in `adapters/`. Atomic catalog writes and cross-process locks enforce revision-checked install/update/enable/remove decisions. Each package generation has its own directory. Acquisition verifies its declared assets again and holds an OS file lease through initialization, process execution and confirmed cleanup. Updating, disabling or removing a package does not replace a running connection's assets. Updates preserve disabled state. Collection removes only unreferenced, unleased generations; crash-abandoned review staging cleanup is still pending.

See [the process contract](adapter-process.md) for framing, service methods, ownership, cancellation and failure semantics. [Custom advertised services](custom-services.md) are selected in each source's Additional services field and exposed to installed apps through reviewed `services.<id>` grants. The transfer bridge, public adapter package schemas/SDK/starters, publisher authentication, process-tree containment and non-Windows runtime verification remain open.

## Native integration evidence

```powershell
npm run tauri -- build --debug --no-bundle --config src-tauri/tauri.adapter-probe.conf.json
node scripts/run-extension-probe.mjs
```

The probe builds two versions of the practice adapter and uses the actual desktop, native catalog, process host and service wrappers. The operating system's chooser is replaced by fixture packages. It checks explicit trust, install/update/disable/remove, running-generation leases, real file/console calls, mixed source identity, unavailable capabilities and reconnect. It also replaces only Files through the production UI, verifies changed file contents with the same live console handle, refuses old handles and invalid replacement identities, and checks cancellation before dispatch. Its installed SDK app checks custom-service discovery, permission denial, JSON calls, errors, cancellation reaching the process and explicit acceptance after reconnect/source replacement. Unit tests separately cover late cancellation after commit and stale status revisions. It uses separate probe application data and no real remote host or system clipboard. This is Windows integration evidence, not a test of FTP, serial, Telnet, another native platform or the operating system's chooser. Cancellation during native adapter initialization and cleanup failure presentation still need dedicated desktop walkthroughs.

The extended-services checkpoint passes 51 checks. It additionally opens the configured adapter through the connection UI, verifies advertised capabilities, creates/saves text, rejects stale text revisions, creates a folder, renames/moves/removes a file, and applies settings with stale-revision refusal. These calls use the production native service wrappers and a separate synthetic adapter process.

The runner writes `.local/native-extension-probe/result.json`. Restore the normal desktop afterward with `npm run verify -- --native`; the special probe executable is not a distributable desktop build.
