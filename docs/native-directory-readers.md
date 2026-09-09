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

The native providers and workspace ownership layer support incremental reads.
The current `list_directory` IPC call, bundled Files/pickers and the public app
broker still use materialized `list()` results. Consequently, this checkpoint
does **not** make the whole desktop directory pipeline incremental. Remaining
work is native reader registration and cancellation, source/window ownership
through IPC, broker paging, and incremental adoption by bundled consumers.
Keep the [incremental browsing gate](kernel-roadmap.md) open until those paths
are exercised end to end. Transfers already have their own incremental readers.

## Evidence

```sh
cargo test -p shellcanvas-core --test directory --locked
cargo test -p shellcanvas-adapter-runtime --test services --locked
cargo test -p shellcanvas directory_pages_and_cleanup --locked
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

The authorized read-only `root@evtinsait` probe on 2026-09-09 also passed the new
SFTP reader's first page and early close, complete home/root/parent browsing,
canonical text locations, UTF-8 preview, PTY input/output/resize and disconnect.
It changed no remote files. This is Linux-host integration from Windows; it does
not establish the remaining UI pipeline or native macOS/Linux client support.
