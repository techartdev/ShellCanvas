# Remote file changes

The Files app now offers **New folder**, **Rename** (F2) and **Delete** (Delete key) through its context menu. A toolbar button opens New folder; Folder actions also opens a new text-editor draft in the current folder. Deletion requires a dialog that displays the exact remote path and explains permanence. Cancel does not call the provider. Files and editor operations update all Files windows in the same session while retaining their folder paths and filters.

**Cut / Paste here** moves an item between Files windows within one workspace. A shared banner shows the pending item and allows cancellation before pasting. See [file clipboard behavior and verification](file-clipboard.md).

The Editor supports **Save as** (Ctrl+Shift+S). Saving an unnamed draft (Ctrl+S) opens this form too. Choose an existing remote folder and one name. New names use no-clobber creation; existing regular text files require a separate replacement review and revision-checked confirmation. After saving, the editor tracks the returned canonical path and revision, so subsequent Save uses existing-file conflict detection. Empty files are supported. UTF-8 size and binary bounds are the same as existing text editing. See [Save As behavior](text-editor.md#save-as-replacement).

## Provider behavior

**Move to folder…** moves the selected file, symlink or folder within this host's file service. The dialog shows the source, destination folders, provider-defined home/roots and parent navigation, plus an address field. Open a typed address first, review the returned destination, then choose **Move here**. The name stays the same. Same-folder destinations are disabled; errors retain the chosen destination. Cancel/Escape perform no move. Success refreshes all Files windows in the session while retaining their current folders. Session replacement/loss disables the dialog; it cannot silently adopt a new service binding.

- `FileMutationService` is an optional contract; apps call session-bound methods. `files.manage` exposes folder creation/rename/deletion, and `files.create` exposes new text files independently of atomic replacement support. Servers/permissions can still refuse individual operations.
- The current implementation uses SFTP packets, not shell command construction. Names are validated as single path components. Parent paths are resolved by the server; callers cannot rename/delete a filesystem root through these APIs.
- New text is written in bounded chunks to an exclusive temporary sibling, optionally fsynced, then committed through standard SFTP v3 rename, which refuses an existing destination. The OpenSSH atomic-replacement extension is used only for revision-checked saves, including confirmed Save As replacements. New files request mode 0600; new directories request 0755, subject to server policy/umask.
- Rename/delete use a token derived from listed size, mtime, mode, UID and GID. The item is checked with lstat immediately before the operation. Rename does not overwrite another name. Deleting a symlink removes the link itself, and deleting a directory only attempts rmdir on that one directory.
- Mutations and editor saves share a lock within one workspace's SFTP service. This does not lock other processes, other workspaces or other connections. Listing tokens are **metadata checks**, not content hashes or atomic compare-and-swap: same-size edits within timestamp granularity, a replacement with identical metadata, or an external change after the check can be missed. SFTP does not provide a general atomic conditional delete/rename.
- Errors retain the form/draft. A lost operation acknowledgement or session disposal after a successful backend result reports that the remote outcome may be uncertain. Refresh/inspect the destination before retrying. Temporary-file cleanup is attempted after failures when a handle was acquired; unsuccessful cleanup reports its path. A lost temporary-open acknowledgement reports the candidate path for inspection.
- Moving has a separate optional `FileMoveService` and `files.move` capability. Native IPC resolves it from the owning session. The SFTP implementation shares the mutation lock and listing precondition, resolves the destination, refuses collisions and self/descendant destinations (including resolved aliases), and uses standard no-replacement rename. Nonempty folders move in one server operation. There is no copy/delete fallback across filesystems. Symlinks themselves move without rewriting stored targets; relative links can therefore resolve differently afterward.

## Current limits

Only files, symlinks and **empty** directories can be deleted. There is no recursive delete, remote trash, undo, cross-host move, or remote copy/duplicate yet. Already-open editors follow confirmed workspace rename/move results, including descendants of folders, while preserving drafts and conflict revisions; see [editor coordination](text-editor.md). [Files navigation, history and previews](file-navigation.md) also follow confirmed workspace relocations. Externally initiated moves are not tracked. Regular-file upload/download and cancellation are described in [transfers](transfers.md). Navigation is provider-owned; the production adapter still uses POSIX SFTP conventions. Other production providers and composite adapters remain backlog items.

The Windows native walkthrough browsed `/etc`, used Copy folder path from the Files menu, and pasted the exact path into an unsaved editor draft through the OS clipboard. The draft was discarded without a remote write. Selected-file/text copy and clipboard-path navigation still need native walkthroughs; their browser fixture checks remain separate.

## Evidence

The live `file_actions_probe` passed on the authorized Linux/OpenSSH host using a newly created `/tmp/shellcanvas-files-UUID` directory only:

- UTF-8/CRLF creation/readback and mode 0600.
- Duplicate create and rename refusal with original/sibling preservation.
- Concurrent new-file creation through two independently initialized SFTP channels: exactly one writer succeeds.
- New folder, nonempty-folder refusal, child deletion and empty-folder deletion.
- Rename including Unicode/quoted names, stale metadata refusal, symlink deletion with target preservation, invalid-name rejection and temporary-file cleanup.

The probe removes its exact test files and then removes its empty test directory; it does not accept a production path or recursively clean unexpected contents. A separate [unprivileged permission probe](permission-validation.md) now verifies denied operations, data preservation and subsequent allowed operations using the existing nobody account. Browser folder/editor denial recovery also passed. Forced transport-loss write outcomes remain an integration gate.

```sh
cargo run -p shellcanvas-core --example file_actions_probe -- HOST USER KEY_PATH
```

The browser workspace fixture passed new-folder/duplicate-name feedback, F2 rename, cancel/confirm deletion, Save As collision with draft retention, successful new-file save, refresh in two Files windows, and a subsequent ordinary editor save. Session tests verify capability rejection, host-scoped change notifications and uncertain completion after disposal.

The move slice passed 38 frontend tests, 32 Rust tests, all-target Clippy and browser checks for browsing/review, collision refusal, permission denial/retry, refresh in two Files windows, opaque locations, invalid addresses and Escape cancellation. The dialog was visually checked at 1280×720. File-location tests cover synthetic Unix, drive and opaque models; these do not establish production support for other systems.

`cargo run -p shellcanvas-core --example move_probe -- HOST USER KEY_PATH` passed on evtinsait inside a new `/tmp/shellcanvas-move-UUID` directory: collision/data preservation, stale/same/missing/invalid destination refusal, Unicode names, file content/basic metadata, nonempty folders, symlinks, self/child/alias refusal, exact cleanup and disconnect. The extended `permission_probe` passed real unprivileged source/destination refusal and later permitted moves with cleanup. Cross-filesystem refusal, physical connection loss during move and a native GUI move walkthrough remain integration checks.
