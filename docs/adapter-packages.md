# Runtime connection adapters

The Windows desktop can install a separately compiled native adapter while running. Open **Apps → Connection adapters → Install adapter**, choose the prepared package's `adapter.json`, review its identity and size, and explicitly accept its native-code trust requirement. Installation copies the reviewed bytes into local application data; it does not execute them.

Adapters run with the user's OS permissions. They are different from isolated desktop UI apps and their broker grants. SHA-256 checks detect changed package contents; self-declared hashes do not authenticate a publisher. Install only native programs whose source you trust.

## Connect a workspace

Choose **Connect a host → Use connection adapters**. Select an installed, enabled adapter and complete its configuration fields. A connection may provide both Files and Terminal, or use **Add another connection** to assign those roles to separate adapter processes. Roles are explicit: an unavailable service is disabled rather than silently routed elsewhere.

The current bridges provide read-only file browsing/previews and console byte streams, with optional resize. Unsupported desktop actions remain unavailable. A device that advertises only files can still open a workspace. Failure to initialize any selected source currently fails the initial composite connection; after connection, source availability is tracked independently.

Adapter connection settings currently survive whole-workspace reconnect in memory. Password fields are excluded and must be entered again. Reconnect preserves the desktop windows and creates fresh native session/console handles. It can use the currently installed version of the same adapter, while preserving the original service assignments and non-secret configuration. Persistent adapter profiles, independent source replacement, and combining the built-in SSH connector with an installed adapter remain future work. The existing saved SSH profiles continue to use their own connection flow.

## Prepare a practice package

The repository supplies a synthetic adapter with paged files and an echo console. It uses no remote host or real protocol credentials. From the repository root on Windows:

```powershell
cargo build -p shellcanvas-adapter-runtime --bin fixture-adapter --locked
node scripts/pack-adapter.mjs examples/fixture-adapter/adapter.json target/debug/fixture-adapter.exe .local/practice-adapter-package
```

Choose `.local/practice-adapter-package/adapter.json` in the installer. The output directory must not already exist; use a fresh directory when producing another package. The helper copies declared assets, computes their sizes/hashes, expands `platform: "current"` and `{exe}`, and writes the installable manifest last. A failed packaging attempt may leave an incomplete output directory.

## Manifest and catalog

Installable manifests use schema version 1 and contain `id`, `name`, semantic `version`, `description`, exact `platform` (for example `windows-x86_64`), `entrypoint`, optional `arguments`, declared `files`, and optional `configuration`. Each file specifies a relative `path`, byte `size`, lowercase SHA-256 `sha256`, and optional `executable` flag. The entrypoint must be declared executable. Configuration fields contain `id`, `label`, `kind` (`text`, `password`, `number`, or `boolean`), optional `required`, and an optional typed `default`. Password defaults are forbidden. Unknown configuration keys and invalid types are rejected before launch.

The installer rejects links, escaping paths, case aliases and reserved Windows names. Metadata has a 1 MiB parsing bound. Asset copying and hashing use 64 KiB chunks; there is no arbitrary total payload or file-tree entry limit. Review captures a staged snapshot, so changing the original folder cannot change the package being approved. Review requests are window-owned, cancelable, single-use and expire after ten minutes.

The catalog lives under Tauri's local application-data directory in `adapters/`. Atomic catalog writes and cross-process locks enforce revision-checked install/update/enable/remove decisions. Each package generation has its own directory. Acquisition verifies its declared assets again and holds an OS file lease through initialization, process execution and confirmed cleanup. Updating, disabling or removing a package does not replace a running connection's assets. Updates preserve disabled state. Collection removes only unreferenced, unleased generations; crash-abandoned review staging cleanup is still pending.

See [the process contract](adapter-process.md) for framing, service methods, ownership, cancellation and failure semantics. [Custom advertised services](custom-services.md) are selected in each source's Additional services field and exposed to installed apps through reviewed `services.<id>` grants. Text editing, mutation, transfer and settings bridges, public adapter package schemas/SDK/starters, publisher authentication, process-tree containment and non-Windows runtime verification remain open.

## Native integration evidence

```powershell
npm run tauri -- build --debug --no-bundle --config src-tauri/tauri.adapter-probe.conf.json
node scripts/run-extension-probe.mjs
```

The probe builds two versions of the practice adapter and uses the actual desktop, native catalog, process host and service wrappers. The operating system's chooser is replaced by fixture packages. It checks explicit trust, install/update/disable/remove, running-generation leases, real file/console calls, mixed source identity, unavailable capabilities and reconnect. Its installed SDK app also checks custom-service discovery, permission denial, JSON calls, errors, cancellation reaching the process and reconnect approval. It uses separate probe application data and no real remote host or system clipboard. This is Windows integration evidence, not a test of FTP, serial, Telnet, another native platform or the operating system's chooser.

The runner writes `.local/native-extension-probe/result.json`. Restore the normal desktop afterward with `npm run verify -- --native`; the special probe executable is not a distributable desktop build.
