# Remote text editor

The bundled Editor opens from the dock or a file's context menu. Each window has an independent document, bounded undo/redo history, find, wrapping, clipboard menu and unsaved indicator. It reads regular UTF-8 files up to 256 KiB. Uniform CRLF line endings round-trip on save. Save updates an existing file; **Save as new file** creates a new name without overwriting another destination. See [file actions](file-actions.md) for new-file behavior and limits.

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
