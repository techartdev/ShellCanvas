# File clipboard and Windows transfers

Files uses **Copy** / Ctrl+C for up to 16 selected regular files. Paste in another folder in the same workspace queues revision-checked copies, retaining sources and refusing existing destinations. The clipboard is shared across Files windows. Copy name/path remain explicit text actions; preview, address, terminal and editor text clipboard behavior is unchanged.

On Windows, Copy also publishes virtual files to Explorer. No file bytes are fetched at Copy: the native clipboard exposes descriptors and streams the bytes when Explorer pastes. Keep ShellCanvas and the connection open until completion. There are no staging files or JavaScript byte buffers. The provider checks the captured source revision and size, including final verification before returning the last bytes. Explorer owns its progress, destination collision prompts and partial-file handling.

Copy local files in Explorer, then use **Paste here** / Ctrl+V on the Files surface to upload them. Rust reads the Windows file list only on explicit Paste, validates up to 16 regular files, retains their handles and returns session/app-owned transfer tickets. The existing queue supplies progress, cancellation, source checks, temporary-file cleanup and no-overwrite publication. Folders, links, duplicate destination names and unsupported clipboard formats are refused. The captured remote destination is not changed by later navigation.

The Windows clipboard is authoritative. A newer Copy in another application replaces the older remote selection; returning to ShellCanvas clears stale indicators, and every file Paste checks again. Text clipboard contents are not interpreted as file paths or remote commands. Pasting text in Files gives guidance to use an editor or terminal. Clipboard identity tracks the owned OLE data object so delayed rendering does not invalidate a still-current remote selection.

**Cut** / Ctrl+X still moves one item within its remote workspace when pasted there. It also replaces the Windows clipboard. A regular file with download support can be pasted into Explorer, where it is copied and its remote source is retained; this is stated in the banner. Folder/link cuts remain workspace-only. Likewise, pasting a locally cut file uploads a copy and retains the local source. Cross-device deletion-after-transfer/move semantics remain unimplemented.

Multi-file **Download files…** uses one native destination-folder picker and then the existing transfer queue. Names are preserved; the batch refuses nonportable names, case-colliding names and existing destinations before queuing. Single-file Download retains its Save dialog so the user can choose a different name.

## Boundaries

- Source locations remain opaque. The frontend does not construct remote paths or receive local clipboard paths.
- Remote Copy/Paste stays within one file-service binding; this does not implement cross-host copying.
- Directory recursion, other applications' virtual-file inputs, images as new files, clipboard history, cross-device moves and native macOS/Linux file clipboard adapters remain follow-ups.
- SFTP revisions are metadata preconditions, not content snapshots or distributed locks. See [transfer guarantees](transfers.md).
- Remote virtual-file pastes are owned by Explorer and are outside the in-app transfer queue. Disconnecting or quitting during one can fail the transfer; retain both until completion.

## Verification — 2026-09-08

- 84 frontend tests and 62 Rust tests passed, including caller/app ownership, stale preparation cleanup, copy cancellation, immutable selections, Unicode file-list decoding, invalid inputs, stream seeking, empty files and changed-source failure. All-target Clippy passed.
- `/tests/fixtures/copy-paste.html` verified multi-selection Ctrl+C and the Copy menu, two-window remote Paste, one-picker multi-download, failure/cancellation, local-file replacement of a remote selection, and text replacement refusing stale-file Paste. Its synthetic services are separate from native verification.
- The opt-in `explorer_clipboard_probe` successfully pasted two generated virtual files through real Explorer. Neither stream opened before Paste; both 8,388,625-byte results matched SHA-256 `485a584410e070b9d289cb2a75ee695b20860585e15736e6871364f3680e6526`. The user also confirmed multi-file remote-to-PC copying on evtinsait.
- The updated native workspace then received those two local files through Explorer Copy and the real Files **Paste here** menu. Both uploads reported Completed, appeared in the remote listing, and independent SSH readback matched both hashes. This exercised the authorized root connection to evtinsait and only an owned UUID test directory. Exact generated remote-file cleanup passed.
- Native Ctrl+V input is covered by the shared handler/browser checks; the live incoming walkthrough used the menu. Network interruption during Explorer paste, native Cut interoperability and other platforms remain separate checks.
