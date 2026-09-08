# File transfers

The [system clipboard integration](system-clipboard.md) adds multi-file remote Copy/Paste, Windows Explorer streaming in both directions, and multi-file downloads through one destination-folder picker. The existing queue/publication guarantees below apply to uploads, downloads and in-app copies; Explorer owns external paste progress and local publication.

Real unprivileged SFTP checks now cover denied uploads/private downloads and successful transfer recovery on the same services. See [permission validation](permission-validation.md). Physical-network interruption and broader Windows GUI error-path checks remain separate.

Files now supports native **Upload files** and **Download selected file** actions in its toolbar and context menus. Upload chooses up to 16 regular local files and captures the current remote folder. Download chooses a new local filename for one selected regular remote file. Canceling either picker creates no transfer. Existing destinations are refused; the first version never replaces them, even if the system save dialog offered replacement.

Each Files window has a sequential queue with progress, cancellation, clearable results and a collapsible panel. Active work stays above finished history. Navigation and other windows remain usable, and completed uploads refresh Files windows in the same session. Closing the owning window, disconnecting its workspace or quitting the app is guarded while a picker or transfer is active. Cancel first and wait for its result. A failed cancellation stays tracked and can be retried; it does not release the close guard or silently start an unwanted queued upload.

## Service boundaries

### Copy to folder

The selected regular file's context menu offers **Copy to folder…** when `files.copy` is available. The destination browser keeps the original filename, requires a different folder, and queues the copy alongside uploads/downloads. The source remains in place and existing destinations are refused. Completion refreshes Files windows in that workspace. Clipboard Copy/Paste now also queues multiple regular-file copies; Cut/Paste moves one item within the workspace.

The transport-neutral `copy_regular_file` helper streams through one explicitly bound `FileTransferService`, with one 32 KiB chunk in memory. Bytes travel through the desktop process, without JavaScript buffers, local staging files or remote shell commands. Both size and the provider's final source revision are checked before publishing. Cancellation or failure aborts both handles; cleanup failures remain visible. Successful publication still reports success if cancellation arrives afterward. This inherits the SFTP metadata-revision limitations below.

This action covers one regular file within one workspace file service. Directory/symlink copies, cross-host copying and renamed duplicates are separate work.

Verification on 2026-09-08: 72 frontend tests, 56 Rust tests, all-target Clippy and the standard Windows debug build passed. The copy browser fixture checked cancellation leaving an empty destination, successful source/destination browsing in separate windows, and a visible collision error. The live `copy_probe` copied 1 MiB + 7 patterned binary bytes with a quoted Unicode filename, verified both files, refused collision and stale revision, canceled a partial copy, and removed its owned `/tmp/shellcanvas-copy-UUID` directory. This probe exercises the provider/helper. A subsequent [Windows GUI walkthrough](native-file-workflows.md#regular-file-copy-follow-up) passed success/progress, busy guards, exact binary readback and collision refusal. Native cancellation and physical-network interruption remain separate gates.

```sh
cargo run -p shellcanvas-core --example copy_probe -- HOST USER KEY_PATH
```

`FileTransferService`, `TransferReader` and `TransferWriter` live in `crates/service-contracts`, without SSH or desktop dependencies. Locations remain provider-owned strings. A reader declares its size, streams bounded chunks and verifies the source at finish. A writer receives a parent/name and declared size, accepts bounded chunks, and publishes without overwriting at finish. Both have explicit abort cleanup. The initial implementation is SFTP; this does not add another production protocol.

Native Rust owns local file dialogs and retained upload handles. Frontend apps receive session-owned transfer tickets, never a general local-path read/write API. Tickets can start once; another host cannot run or cancel them. The registry allows 32 queued/running tickets, and its semaphore allows four active streams across all windows. Streams use 32 KiB chunks; file bytes do not pass through JavaScript or load entirely into memory. The frontend queue keeps at most 50 previous finished entries when adding more work.

## Publication, changes and cancellation

- Uploads write an exclusively created temporary sibling, request mode 0600, optionally fsync, then use standard SFTP rename to a new destination. Source size/mtime are checked before and after streaming. No local mode/ownership/timestamp preservation is promised.
- Downloads check the selected listing revision, require a regular file and verify its open handle and path metadata after reading. A local sibling temporary file is flushed and synced before publication with `persist_noclobber`. Existing or newly raced-in destinations are preserved.
- Revision tokens are metadata checks, not content snapshots. Same-size changes within timestamp granularity or external replacements with identical metadata can evade detection. General distributed compare-and-swap is not available through SFTP.
- Cancellation is checked between bounded I/O operations. An outstanding SFTP request can delay cancellation until its result or timeout. Final publication is allowed to finish; a late cancellation cannot turn confirmed completion into a canceled result.
- Failure/cancellation closes handles and removes owned temporary files. Cleanup errors report the relevant path. A lost publication acknowledgement is reported as uncertain: inspect the destination before retrying. Best-effort Drop cleanup helps with abandoned handles while the runtime is alive, but forced termination or loss of connectivity can leave a temporary file.

Directories, recursive transfers, resume, automatic retry and overwrite confirmation are not implemented. The queue is in memory and does not survive app restart. Native pickers and filesystem behavior have been checked on Windows only; macOS/Linux/mobile remain separate validation gates. Permission-denied and physical-network interruption remain live integration gates.

## Verification

- Native engine tests cover binary streaming, local no-clobber publication, canceled/failed download cleanup, canceled upload cleanup, late cancellation after commit, ticket ownership, start-once and session closure.
- Queue/binding tests cover sequential work, queued and active cancellation, cancellation failure/retry, late completion, stale picker cleanup, unowned tickets and React StrictMode lifecycle.
- `/tests/fixtures/transfers.html` uses synthetic services with the real Files UI. Browser checks covered upload refresh, duplicate-name failure, queued/active cancellation, downloading, busy guards and panel collapse at short window heights.
- The live `transfer_probe` uploaded and downloaded 8 MiB + 7 bytes with matching SHA-256, checked Unicode/quoted names, empty files, stale selection, changed source, collisions, concurrent create refusal and partial-upload cleanup. It created and removed only its own UUID directory and exact files.
- A running Windows Tauri workspace used the actual Open/Save dialogs to upload and download an 8 MiB generated binary through the authorized Linux SSH host. Both local hashes matched. Files showed progress and completion and refreshed its listing. The exact generated remote file and empty test directory were removed afterward.

For an explicitly authorized test host with an existing known-host entry:

```sh
cargo run -p shellcanvas-core --example transfer_probe -- HOST USER KEY_PATH
```

The probe generates its own `/tmp/shellcanvas-transfers-UUID` directory; it does not accept arbitrary production paths. The native fixture `/tests/fixtures/native-workspace.html` is a development-only entry that consumes ignored `.local/native-workspace.json` connection options. It is never imported by production and requires an explicitly prepared local configuration and authorized host.
