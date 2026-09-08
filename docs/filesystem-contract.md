# Provider-owned filesystem navigation

File apps treat paths as nonempty opaque strings. They display them and pass them back to the owning service without splitting, joining or rewriting separators. Entered paths and clipboard paths are passed unchanged. Providers validate their own path and filename rules.

`crates/service-contracts` contains `FileSystemProvider`, `TextFileService`, `FileMutationService`, `FileTransferService`, bounded transfer handles and their data types. Its dependency tree contains serde, async-trait and anyhow, with no SSH, SFTP or Tauri dependency. The SSH core implements and re-exports these contracts. Lifecycle, terminal and composite-binding extraction remain separate work. See [transfer ownership and publication](transfers.md).

## Navigation data

- `list(None)` in Rust, or `services.list()` in TypeScript, selects the provider's default location. Apps do not send an assumed `.` or `/`.
- A `Directory` includes `path`, display `name`, optional `parent`, optional `home` place, named `roots`, and entries. A null parent disables parent navigation; an absent home hides Home. Multiple roots become separate places in Files.
- Every entry supplies its own `path` and display `name`. Navigation follows those paths; Back history stores returned locations.
- `TextDocument` includes display `name` and optional `parent` alongside canonical `path`, text, revision and writability. Editor titles and Save As use this metadata. A new draft obtains its destination from the provider's default directory when Files has not supplied one.
- Rust `locate(path)` resolves file metadata for a read-only editor fallback. The native desktop does not derive a parent from a path string.
- Creation takes a parent location plus a separate name; the provider validates the name and returns the canonical location. A name need not share the encoding or separator conventions of its path identifier.

The SFTP adapter currently implements POSIX SFTP conventions, including `/` and the server's canonical `.` directory. Those assumptions stay inside the adapter. This change does not add production Windows or appliance support.

## Evidence

The development fixture `/tests/fixtures/filesystems.html` supplies Unix paths, drive roots, and opaque volume/node/object IDs. Its provider rejects invented locations. Browser checks verified child/parent/root navigation, disabled Parent at roots, multiple drives, absent Home, editor titles independent of object IDs, Save As using provider parents, subsequent normal Save using the new object ID, and a new draft creating a file in the provider's default drive folder.

Three session-binding tests cover unchanged location routing and create/read behavior across those models. A read-only probe on the authorized Linux host verified default/home/root/parent metadata, canonical text locations, preview, terminal input and PTY resize. Frontend tests/build and Rust tests/Clippy passed. Drive and opaque providers are synthetic; real Windows and appliance behavior remains unvalidated.
