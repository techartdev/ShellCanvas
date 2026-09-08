# Remote text editor

The bundled Editor opens from the dock or a file's context menu. Each window has an independent document, bounded undo/redo history, find, wrapping, clipboard menu and unsaved indicator. It reads regular UTF-8 files up to 256 KiB. Uniform CRLF line endings round-trip on save. Save updates an existing file; **Save as** creates a new name or offers explicit replacement review for an existing regular text file. See [file actions](file-actions.md) for behavior and limits.

## Save As replacement

Save As lists the chosen folder and resolves an exact filename through provider-owned locations. New names use no-clobber creation; an item appearing after the listing is an error, never an automatic overwrite. Existing regular files are read before review, using the text service's UTF-8/size/readability limits. Folders, links, ambiguous names and unavailable replacement capability are refused. An unrecognized name alias may fail creation safely; the frontend does not invent provider-specific case or path rules.

Review shows the destination name and exact canonical path. Cancel preserves the draft, and Back allows choosing another destination. Replace file uses the revision captured during review. Failure keeps that revision and the draft; Back followed by Save performs a fresh review before another confirmation. No conflict triggers automatic re-reading or overwriting. Other open editor drafts retain their own revisions and buffers. After success, this editor adopts the returned path/revision and keeps its undo history. Replacement writes the source draft's line-ending convention, as normal Save As does.

A changed/lost session invalidates the review and suppresses late results. If a write was in progress, the dialog asks the user to inspect the destination before trying again; it does not claim the remote write was canceled. Native service ownership and the existing SFTP save limitations still apply.

Five tests cover preparation without writes, canonical opaque locations, reviewed revision conflicts, safe creation races, unsupported kinds/capabilities and unreadable targets. Browser fixtures passed cancellation, explicit replacement, ordinary Save afterward, permission failure, conflict followed by a fresh review, new-file creation and disconnect after a simulated successful remote write without retargeting the draft. In the full desktop fixture, replacing from Editor 2 preserved Editor 1's unsaved buffer and its stale Save was rejected. These are synthetic provider checks; the subsequent native happy-path walkthrough is recorded below.

The follow-up [Windows native walkthrough](native-file-workflows.md) passed Save As replacement on the authorized Linux host in an owned temporary directory: readback proved no write during review and exact Unicode contents after confirmation. The editor adopted the destination and closed cleanly; exact remote cleanup passed. Native replacement failure/conflict injection and editor relocation remain separate gates.

`TextFileService` is a separate optional service contract. The SSH implementation uses a dedicated SFTP channel, with no shell commands or remote agent. Servers without atomic replacement support keep read/preview and new-file creation access; replacing an existing file with Save is unavailable. Per-file permission errors are reported when the operation is attempted.

## Save behavior

1. Resolve and read the file, rejecting non-regular, binary and oversized content. Display its canonical path.
2. Compare the supplied revision against the current content, owner, group and permissions. A mismatch reports a conflict without replacing the file.
3. Create an exclusive temporary file beside the target, write bounded chunks, preserve basic ownership/mode and use server fsync when available.
4. Recheck the target revision and atomically replace it using `posix-rename@openssh.com`. Read back the result before reporting success.
5. On failure, retain the UI draft and attempt temporary-file cleanup. Cleanup failures include the exact temporary path. A lost save acknowledgement is reported as uncertain, rather than claiming that nothing changed remotely.

Saves are serialized across editor windows within one workspace. This is optimistic conflict detection: SFTP has no universal compare-and-swap operation, so another process or separate connection can still race the last check and rename. It is not a distributed lock. Atomic replacement also changes inode identity; ACLs, extended attributes, security labels and hard-link relationships are not preserved by this first implementation. Basic UID/GID/mode preservation is tested. Do not treat this as a specialized editor for files requiring those extended metadata guarantees.

## Unsaved work

Renames and moves initiated in this workspace now update already-open editors, including files inside renamed/moved folders. The provider supplies exact previous/new locations, names and parents; the editor never splits paths or guesses ancestry. Multiple editors follow independently, retaining each buffer, undo/redo history, line endings and original save revision. A manually edited address field is not replaced unless it still names the open document. No remote reload is implied, so an external content change still causes a save conflict at the new location.

Moves/renames wait for running editor operations, open Save As/reload confirmation dialogs and file transfers to finish (the Files form retains its input for retry). During the move, participating editors temporarily disable editing and remote operations; copying remains available. Only confirmed results in the owning active session are applied. Failed or uncertain moves leave the original editor location and draft intact. Tracking is bounded to 256 distinct open locations. Editors opened after a move begins are not redirected by its result. Changes made through a terminal, another connection or an external tool are not tracked. [Files navigation/history](file-navigation.md) now follows these workspace relocations too.

Closing an editor, reloading a file, disconnecting its workspace and closing the app guard unsaved changes. Running editor operations block deliberate close/disconnect until completion. Transport loss preserves the workspace and its editor buffers, disables saving, and permits copying drafts. Reconnecting creates a new session and keeps the editor buffer and original revision in the same workspace; a later save still checks for conflicts. If file support is unavailable after reconnect, the draft remains accessible with remote actions disabled. See [connection recovery](connection-recovery.md). Drafts are in memory; forced termination or a process crash can lose them. No editor content is automatically persisted or sent to an external service.

## Validation

- Async clipboard edits are bound to the initiating document, edit revision and latest clipboard action. A delayed Cut/Paste cannot change a replacement document (even with identical contents), reapply after edit/undo or Save, or report stale failures after replacement/unmount. Clipboard writes already sent to the OS cannot be canceled; Cut only removes text after a successful write that still owns the draft. Caret restoration never steals focus from another control.
- The browser fixture at `/tests/fixtures/editor-clipboard.html` uses the actual Editor with manually completed clipboard promises and identical-content fake documents. Checks passed normal Cut/Paste and undo, CRLF paste normalization, Cut followed by opening another file, Paste followed by edit/undo or Save, failure preserving the draft, and late failure after document replacement or unmount/remount. To reproduce, select text and use Shift+F10, perform the intervening action, then choose **Finish clipboard** or **Fail clipboard**. These are deterministic browser checks, not a new native OS-clipboard walkthrough.
- Unit tests cover undo/redo branches, CRLF serialization, size/binary validation, revision mismatches and workspace preservation after loss.
- The browser workspace fixture covers open from Files, save, undo/redo, close and disconnect cancellation, remote-edit conflicts and retained drafts after simulated connection loss.
- Relocation checks passed file rename/move, parent-folder rename/move, retained dirty text and undo/redo, saving at the final path, and conflict refusal after an external edit. The opaque-provider fixture passed two editors following `moved@1` to `moved@2` with independent buffers. Unit checks cover busy/overlapping work, failure cleanup, session loss, and excluding late/new participants. The live move/rename probes passed explicit location mappings, descendant handling, saving with retained revisions, metadata preservation and exact cleanup. This checkpoint passed 45 frontend and 42 Rust tests, Clippy, production frontend build and the standard Windows debug build; native GUI relocation has not been walked through.
- The authorized Linux test-host probe passed Unicode/CRLF reads, atomic save/readback, UID/GID/mode preservation, stale/external/concurrent save conflicts, binary and size refusal, sibling preservation and cleanup. It created and removed only its own `/tmp/shellcanvas-editor-UUID` directory.
- Native app-close interception is wired through Tauri's close-request event and explicit close/destroy permissions. The earlier Windows clipboard/quit walkthrough passed canceled quit with both drafts retained and explicit discard-and-quit; see [core completion evidence](core-completion.md).

To repeat the **write probe** on an explicitly authorized Linux host:

```sh
cargo run -p shellcanvas-core --example edit_probe -- HOST USER KEY_PATH
```

The probe creates disposable files under `/tmp`, verifies behavior, and removes them. No production file path is accepted by the probe.
