# Native directory readers

The Rust `FileSystemProvider` contract now includes
`open_directory(self: Arc<Self>, path: Option<&str>)`. It returns an owned
`DirectoryReader` with sequential `next()` and idempotent `close()` methods.
`DirectoryPage` contains the usual `Directory` metadata, at most 128 entries,
and a `done` flag. An empty final page is valid; an empty continuation is not.
There is no total directory-entry limit. Paths, metadata and page ordering
belong to the provider.

Readers are single-use scans. After a pending `next()` is canceled, close or drop
the reader and start a fresh scan if needed; never retry an operation that may
already have advanced its provider cursor. Providers must retire canceled or
failed reads and release their resources on drop. Cleanup must remain available
after a workspace or source is retired. Close failure reports uncertainty rather
than silently retrying a remote handle that may already have been released.

## Implementations

- Installed adapters fetch one existing `files.list` protocol page per `next()`.
  Opening does not dispatch a listing. Readers retain only the next opaque cursor
  and directory metadata, and validate metadata continuity, page size and forward
  progress. EOF, close, cancellation and failures release the reader's adapter
  reference. Another reader or service on that process remains independent.
  The wire contract is unchanged: continuation tokens are stateless and allocate
  no remote resource needing a close request.
- The production SSH connection uses `SftpBrowser`, sharing its raw SFTP channel
  with text, action and transfer services. It uses `OPENDIR` / `READDIR` / `CLOSE`,
  retaining one response batch plus the current delivery page. It does not call
  the high-level library's materializing `read_dir`. Each page has a 30-second
  deadline. A canceled open still owns and closes its eventual returned handle;
  close continues when its waiter is dropped. A canceled page cannot be resumed.
  No write extension is needed for browsing. The existing materialized `list()`
  consumer retains its directory-first, case-insensitive presentation order.
- Workspace wrappers check the captured source both before and after each page.
  A page completed after source replacement cannot reach the replacement
  workspace. Cleanup still targets the original reader. A different workspace
  retaining the same connection remains usable.

`collect_directory` explicitly consumes a reader into the original `Directory`
shape and closes it on completion/error. The default `open_directory` adapts
legacy providers through `SnapshotDirectory`; this compatibility path still
materializes. New providers should implement the reader directly. The older
`SftpFileSystem` remains for existing internal probe consumers; production
connection creation uses `SftpBrowser`.

## Current integration boundary

The `open_directory`, `read_directory` and `close_directory` IPC calls register
owned scans with the original native window, workspace and file-source identity.
Opening reserves a reader; the first read opens the provider. Reads are sequential
and validate source ownership before and after delivery. Disconnect, source
replacement and window destruction cancel the matching scans. Cleanup remains
available after read access is retired and never targets a replacement source.

The public app broker and app permission scope use these readers. Each app window
can own 16 scans, and the native registry permits 32 active scans across the
desktop. These are concurrent-resource limits, not directory-entry limits.
Canceled opens keep their capacity until the late handle is closed. Failed or
timed-out cleanup retains its native capacity charge and cached failure until
the physical source disconnects; repeated close does not retry an uncertain
remote operation. Provider open, page and cleanup operations have 30-second
deadlines. A worker failure also reports unconfirmed cleanup.

The broker buffers at most one provider page and splits replies to fit its
1 MiB UTF-8 envelope. It fetches another page only on demand. Early iterator
return, abort, source retirement and frame disposal close the original reader.
Legacy and preview services without a reader use a materialized snapshot fallback.

Bundled Files and system file pickers still use `list_directory` and materialize
their listings. Keep the [incremental browsing gate](kernel-roadmap.md) open
until those consumers are migrated and exercised. Transfers already have their
own incremental readers.

## Evidence

```sh
cargo test -p shellcanvas-core --test directory --locked
cargo test -p shellcanvas-adapter-runtime --test services --locked
cargo test -p shellcanvas directory_pages_and_cleanup --locked
cargo test -p shellcanvas directories::tests --locked
npm test -- --run src/directory-reader.test.ts src/extensions/directory-bridge.test.ts src/session-services.test.ts src/app-services.test.ts
```

The five SFTP tests use the actual protocol over an in-memory duplex connection:
50,000 entries, one-page demand, independent handles, delayed open cancellation,
pending read cancellation, EOF/drop cleanup, retained close outcomes after
cancellation/failure, and malformed entry rejection. The
server supplies 17 entries per batch; the first 128-entry page fetches only eight
batches. Adapter process tests verify demand, independent positions, cancellation
and invalid continuations without poisoning unrelated services. The workspace
test replaces a source while a page is pending and checks original-reader cleanup
and survival of another workspace using that connection.

Five native registry tests cover lazy opening, reader ownership, sequential reads,
late-open cancellation, pending reads, cached cleanup failures, capacity recovery
after physical disconnect and worker panic. Frontend tests cover native IPC
cancellation, app permission routing, one-page demand, UTF-8 envelope splitting,
source changes, early return and cleanup failure delivery.

The authorized read-only `root@evtinsait` probe on 2026-09-09 also passed the new
SFTP reader's first page and early close, complete home/root/parent browsing,
canonical text locations, UTF-8 preview, PTY input/output/resize and disconnect.
It changed no remote files. This is Linux-host integration from Windows; it does
not establish the remaining UI pipeline or native macOS/Linux client support.
