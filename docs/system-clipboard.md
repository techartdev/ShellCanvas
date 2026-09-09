# File clipboard and Windows transfers

Files uses **Copy** / Ctrl+C for selected files or folders. Paste in another folder in the same workspace queues a revision-checked selection job, retaining sources and refusing existing destinations. The clipboard is shared across Files windows. Copy name/path remain explicit text actions; preview, address, terminal and editor text clipboard behavior is unchanged.

On Windows, Copy also publishes virtual files to Explorer. No file bytes are fetched at Copy: the native clipboard exposes descriptors and streams the bytes when Explorer pastes. Keep ShellCanvas and the connection open until completion. There are no local content staging files or JavaScript content buffers. The provider checks the captured source revision and size, including final verification before returning the last bytes. Explorer owns its progress, destination collision prompts and partial-file handling.

Remote Copy selections are shared between bundled Files and installed apps using
the [public clipboard API](app-clipboard.md), within this ShellCanvas process and
the original workspace. Native selection ownership includes the original
file-service instance; a replaced connection or another workspace is refused.
Each paste gets a fresh catalog, so repeated or overlapping pastes cannot change
one another's destination paths. Clipboard inspection returns only kind/version;
the matching version is checked again when preparing the captured selection.
Local lists use upload permission and remote selections use copy permission.
No permission failure falls back to a different transfer kind.

Copy local files in Explorer, then use **Paste here** / Ctrl+V on the Files surface to upload them. Rust reads the Windows file list only on explicit Paste, snapshots root metadata into one disk catalog and returns one session/app-owned selection ticket. All source files open on demand when their transfer runs; changed sources are refused against the recorded metadata. Folder contents are discovered by the queued job. The existing queue supplies progress, cancellation, source checks, temporary-file cleanup and no-overwrite publication. Links, junctions, special files and duplicate destination names are refused. The captured remote destination is not changed by later navigation.

The Windows clipboard is authoritative. A newer Copy in another application replaces the older remote selection; returning to ShellCanvas clears stale indicators, and every file Paste checks again. Text clipboard contents are not interpreted as file paths or remote commands. Pasting text in Files gives guidance to use an editor or terminal. Clipboard identity tracks the owned OLE data object so delayed rendering does not invalidate a still-current remote selection.

**Cut** / Ctrl+X moves one item within its remote workspace when pasted in bundled Files or through the runtime-app API. Its intent and exclusive reservation are owned natively; apps require `files.move` and clipboard file-read permission. Cancel cut retires that intent. A dispatched move waits for its provider outcome and cannot be replayed after an uncertain result. It also replaces the Windows clipboard. A file or folder with download support can be pasted into Explorer, where it is copied and its remote source is retained; this is stated in the banner. Link cuts remain workspace-only. Likewise, pasting a locally cut file uploads a copy and retains the local source. Cross-device deletion-after-transfer/move semantics remain unimplemented. See [current API verification scope](app-clipboard.md).

Multi-file **Download files…** uses one native destination-folder picker and then the existing transfer queue. Names are preserved; the batch refuses nonportable names, case-colliding names and existing destinations before queuing. Single-file Download retains its Save dialog so the user can choose a different name.

## Folder transfers

Folder Copy/Paste works within a remote workspace and in both directions with Windows Explorer. **Download…** on a folder uses a destination-folder picker. **Upload folder…** uses a native folder picker. These actions include nested and empty directories. Providers opt into `files.folders` and implement bounded directory listing plus no-replacement directory creation on their transfer service; the UI and queue never interpret remote paths.

Discovery is iterative and paged, with no application-imposed tree entry or nesting limit. Providers expose a directory cursor returning at most 128 entries per page. Each scan holds one directory cursor at a time; pending directories, source revisions, names and destination locations live in a disposable indexed SQLite catalog. SQLite is bundled into the executable and needs no separate installation. Its suggested page cache is 2 MiB per catalog; this is not a process memory ceiling. The catalog stores metadata, never file contents, and is removed on normal release. Crash recovery/resume is not implemented; a process crash can leave scratch metadata behind.

Local folder discovery retains metadata rather than an open handle for every file. Each source file is opened just before upload and checked against its recorded metadata. Discovery runs as part of the cancellable queue job, before destination creation. Copy to Explorer shows discovered items/bytes and a **Cancel preparation** action, also available through Escape. Cancellation is scoped to the originating app/session. A newer Windows clipboard value prevents a late scan from replacing it.

Links, junctions, reparse points and special files are rejected rather than followed. Windows destination names are validated for traversal, reserved names and case collisions; Explorer virtual paths must fit its 259 UTF-16-unit descriptor limit. Download does not have that clipboard-specific limit (normal filesystem limits still apply). Windows requires a contiguous [FILEGROUPDESCRIPTORW metadata array](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/ns-shlobj_core-filegroupdescriptorw) when Explorer requests the selection. ShellCanvas fills that block directly from the catalog, then serves indexed file streams on demand. This native format still requires memory proportional to the descriptor count; disk space, OS allocation and path limits remain real constraints.

Clipboard Copy/Paste has no application-defined top-level selection cap. One
selection occupies one catalog and one queue slot, including regular files on a
provider without folder support. The queue still limits concurrent jobs/workers;
those limits do not restrict the number of roots inside a job. Root pathnames are
temporarily collected while decoding the native clipboard; tree metadata is
disk-backed and no per-file handle collection is retained. Native root preparation
is not yet interruptible; cancellation discards its returned ticket before run.
Failures stop the batch and preserve completed items, reporting the destination
folder. Upload files and multi-file Download now use the same catalog-backed
batch strategy, without a fixed selection-count limit. Provider, filesystem and
OS format limits still apply.

A queued folder gets aggregate byte progress and cancellation. Its destination root must be absent; ShellCanvas does not merge with or replace an existing folder. Each file is verified and published separately using the existing temporary-file protocol. On failure/cancellation, completed files and created directories remain; the result explicitly reports the incomplete destination. There is no automatic recursive deletion. A late cancellation cannot undo a completed file. Explorer controls collision prompts and partial results for pastes it owns.

Remote plans use revision-checked directory listings and reject copying into the source tree. Source revisions are metadata checks, not immutable filesystem snapshots. Concurrent changes by other processes, especially path replacement on a server without handle-relative operations, remain outside an atomic-tree guarantee. Permissions/timestamps/ownership are not cloned.

## Boundaries

- Source locations remain opaque. The frontend does not construct remote paths or receive local clipboard paths.
- Remote Copy/Paste stays within one file-service binding; this does not implement cross-host copying.
- Other applications' virtual-file inputs, images as new files, clipboard history, cross-device moves and native macOS/Linux file clipboard adapters remain follow-ups.
- SFTP revisions are metadata preconditions, not content snapshots or distributed locks. See [transfer guarantees](transfers.md).
- Remote virtual-file pastes are owned by Explorer and are outside the in-app transfer queue. Disconnecting or quitting during one can fail the transfer; retain both until completion.

## Verification — 2026-09-08

- 84 frontend tests and 62 Rust tests passed, including caller/app ownership, stale preparation cleanup, copy cancellation, immutable selections, Unicode file-list decoding, invalid inputs, stream seeking, empty files and changed-source failure. All-target Clippy passed.
- `/tests/fixtures/copy-paste.html` verified multi-selection Ctrl+C and the Copy menu, two-window remote Paste, one-picker multi-download, failure/cancellation, local-file replacement of a remote selection, and text replacement refusing stale-file Paste. Its synthetic services are separate from native verification.
- The opt-in `explorer_clipboard_probe` successfully pasted two generated virtual files through real Explorer. Neither stream opened before Paste; both 8,388,625-byte results matched SHA-256 `485a584410e070b9d289cb2a75ee695b20860585e15736e6871364f3680e6526`. The user also confirmed multi-file remote-to-PC copying on evtinsait.
- The updated native workspace then received those two local files through Explorer Copy and the real Files **Paste here** menu. Both uploads reported Completed, appeared in the remote listing, and independent SSH readback matched both hashes. This exercised the authorized root connection to evtinsait and only an owned UUID test directory. Exact generated remote-file cleanup passed.
- Native Ctrl+V input is covered by the shared handler/browser checks; the live incoming walkthrough used the menu. Network interruption during Explorer paste, native Cut interoperability and other platforms remain separate checks.

### Folder verification — 2026-09-08

- Regression coverage includes parent relationships with opaque provider identifiers, empty directories, cycle/link/traversal rejection, case collisions, descendant destinations, no-merge publication, cancellation with explicit partial results, and Windows directory descriptors with correct file-stream indices.
- Opt-in `live_folder_roundtrip` exercised the production native tree engine against evtinsait: local folder upload, remote folder copy, downloads, exact byte comparison, Unicode names, a zero-byte file and an empty nested folder. The disposable UUID remote root was removed.
- `SHELLCANVAS_FOLDER_PROBE=1` with `explorer_clipboard_probe` pasted a real Explorer folder containing `Nested/First.bin`, `Second.bin` and `Empty/`. Both 8,388,625-byte files matched SHA-256 `485a584410e070b9d289cb2a75ee695b20860585e15736e6871364f3680e6526`; no stream opened before Paste. Directory metadata follows the Windows [FILEDESCRIPTORW contract](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/ns-shlobj_core-filedescriptorw).

- The Explorer-copied folder was then read through the production native file-list decoder and clipboard upload preparation. Upload, remote copy and downloads on evtinsait preserved every byte of both 8 MB files and both empty/nested directories. Its disposable remote root and the exact owned local files were removed. This checks the native clipboard/transfer path; a full folder-paste walkthrough inside the packaged Files window remains a user acceptance check.
- Current regression gate: 84 frontend tests, 67 Rust tests, and all-target Clippy passed; both opt-in native/live probes also passed.

### Scalable discovery verification — 2026-09-08

- Replaced the original entry/depth caps with paged discovery and a disposable metadata catalog. Synthetic fixtures scanned 50,000 leaves and a 512-level provider tree with one directory cursor at a time and no file-content reads. A stalled cursor canceled and closed; a 2,500-file local scan retained no source handles and rejected a subsequently replaced file.
- A Windows unit fixture produced 10,000 catalog-backed descriptors without opening source files; requesting one indexed stream opened only that source. The browser slow-preparation fixture displayed 50,000 discovered items and recovered its controls after Cancel. Replacing the service binding during a scan canceled the old request and restored the new binding's controls.
- The live evtinsait folder round trip passed again through the new engine, including local upload, remote copy, exact download bytes, Unicode names and empty directories. The owned remote fixture was removed.
- Real Explorer pasted the new catalog-backed folder offer: both 8,388,625-byte files matched the SHA-256 above and nested/empty directories were preserved. No file stream opened before Paste. An earlier probe timed out while the automation was navigating; repeating after the destination was ready passed with two verified streams.
- Regression gate: 85 frontend tests, 72 Rust tests and all-target Clippy. Large-tree tests use synthetic providers; they are not a 50,000-file live-network benchmark.
