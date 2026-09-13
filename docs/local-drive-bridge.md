# Attach remote folders to this computer

Status: signed native packages published; integrated installer in the next desktop build, 2026-09-13. See the authoritative
[implementation checkpoint](filesystem-integration-progress.md). This is separate from
[remote drives and mounts](drives-and-mounts.md), which manage storage on the host.

## Install and update

Use Drive Bridge **0.1.1 or newer** with the current desktop's protocol 2. Version
0.1.0 was withdrawn after it was built without the lifecycle PR; its signature
does not make it protocol-compatible. The desktop now compares signed metadata
against the actual SDK protocol constant and rejects that obsolete release.

In a desktop build containing the integrated installer, open **Settings → Files →
Drive Bridge**, select **Install Drive Bridge**, then review and approve the
download. ShellCanvas selects the package for the **local client** and verifies
its publisher signature, protocol version, size and SHA-256 before installing
it privately in the active profile. No executable picker is required. Existing
0.1.5 desktop releases do not yet contain this installer.

[Native releases](https://github.com/techartdev/ShellCanvas-DriveBridge/releases)
currently cover Windows x64, Linux x64, and Intel/Apple silicon macOS. Install
WinFsp, your Linux FUSE runtime, or macFUSE separately; Settings shows runtime
detection and setup guidance. macOS native mount acceptance remains pending.

**Check for updates and drivers** checks the official release. Detach local
drives before installing an update; failed verification leaves the current
installation intact, and official updates cannot downgrade it. Host settings,
credentials, app data and remote files are not replaced. Offline/development
executable selection remains under **Advanced** and is explicitly unverified.

Files → Drives highlights attached volumes and shows **Attached as W:** (or
the local mount path) with **Detach**. State refreshes while the view is open,
including mappings changed in other windows. It matches the exact file-provider
connection and remote root, not just the drive name. Busy detach and failed
cleanup retain their existing safeguards.

## Product decision

The selected design is an **Attach to this computer…** action in Files, backed by
the separate public, free [Drive Bridge app](https://github.com/techartdev/ShellCanvas-DriveBridge).
The core has no WinFsp/FUSE dependency. A user selects a folder or a browsable
volume, chooses a local drive letter/folder and read-only or read/write access,
then opens it from ordinary local applications. Existing Linux and Mac SSH
hosts are sufficient for Windows client testing; a Windows remote host is not
required. Nothing new needs to run on an SFTP-capable remote host.

The desktop owns root grants, connection lifetime and credentials. The separate
native bridge owns OS filesystem callbacks and driver dependencies. The two
communicate through scoped inherited pipes. Native-code installation and mapping
management must be explicit; an isolated web frame cannot supply arbitrary launch
paths. Keep installation optional so Files and Terminal retain their small
dependency footprint. The bridge repository documents its GPL license and the
dependencies' separate terms. Modern supported client systems are the priority;
legacy Catalina client compatibility is outside this goal.

Settings → Files lists active attachments. **Open folder** opens the registered
local location in the system file manager; it is available only while attached.
**Detach** requests ordinary native unmount and keeps a busy mapping available.
If shutdown cannot be confirmed, **Retry cleanup** retains the original helper
ownership and checks it again. A stopped process alone is insufficient: the local
OS mount table must also show that the location is unmounted. If a stale mount
remains, remove it using system disk tools, then retry the check. ShellCanvas keeps
the connection reserved until confirmation and does not force-unmount the path.

## Local platform backends

| Client OS | Recommended starting point                           | Setup and scope                                                                                                                        |
| --------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Windows   | Native WinFsp API with a Rust bridge                 | Signed driver/runtime installed once; drive letter or local directory. No WSL or Cygwin required for this native approach.             |
| Linux     | FUSE/libfuse backend sharing the Rust provider logic | Local directory mount; distribution-specific runtime/helper setup.                                                                     |
| macOS     | Evaluate macFUSE, including its modern FSKit backend | Current macFUSE requires macOS 12+. The FSKit backend targets macOS 26. Catalina needs a separate legacy-runtime decision and testing. |

Sources: [WinFsp distribution](https://winfsp.dev/rel/),
[native callback API](https://winfsp.dev/doc/WinFsp-API-winfsp.h/),
[Linux FUSE documentation](https://www.kernel.org/doc/html/latest/filesystems/fuse/),
[macFUSE platform requirements](https://macfuse.github.io/).
These are local client requirements: the old Mac can still be a remote SFTP host.

WinFsp is the proposed Windows dependency, not a commercial drive-manager app.
Its GPLv3 license includes a FLOSS exception and a separate commercial option.
Before distributing a bridge, verify the exact exception and packaging against
ShellCanvas's MPL-2.0 licensing; do not assume a future private bridge is covered.
Review macFUSE redistribution separately when selecting that backend.
See [WinFsp licensing](https://winfsp.dev/com/).

[SSHFS-Win](https://github.com/winfsp/sshfs-win) demonstrates the desired user
workflow, but wrapping it would introduce separate SSH/session handling and an
SSH-specific foundation. Prefer reusing our accepted file provider and trust
decisions. A local SMB/WebDAV gateway is not the selected approach: it introduces
another server/protocol layer instead of implementing filesystem callbacks.

## Small, optional core extension

Flow: local application → OS filesystem framework → native Rust mount service
→ accepted Files provider → remote filesystem.

The existing `FileTransferService` is designed for checked, sequential whole-file
transfers. `TransferReader.read()` has no offset, and `TransferWriter.finish()`
publishes an absent destination. These contracts should retain their meaning.
They are insufficient for applications that seek within a file or save through
a temporary file followed by replacement.

Add an optional handle-based filesystem capability, initially implemented by
the SFTP provider. Derive the final method signatures from the Windows prototype,
rather than expanding the mandatory provider or isolated-app API in advance:

- Read-only subset: metadata, incremental directory enumeration, open/close and
  reads at explicit offsets.
- Writable subset: create, writes at offsets, truncate, flush, rename/replace,
  removal and directory creation, with explicit supported metadata behavior.
- Optional semantics: links, locks, durability and other OS-specific features.
  Never advertise guarantees that the underlying provider cannot deliver.

Simple devices keep their current interfaces. A browse/download-only provider
does not automatically qualify for mounting. Future FTP/API adapters can opt in
where their semantics support it; do not hide missing random writes behind
unbounded whole-file caching.

## Lifetime, access and failures

- Pin each mapping to its Files source, account, verified host identity and root.
  Switching the visible workspace must never retarget a drive. Keep old open
  handles invalid after a connection generation changes.
- Run filesystem I/O outside the WebView/UI thread. Prefer a supervised native
  helper with user-restricted authenticated IPC. Keep credentials in the core;
  do not pass passwords or keys on command lines.
- A read/write attachment is an explicit grant for local applications to modify
  that remote subtree. The mount cannot ask a UI question for every OS write.
  Define path and symlink handling before exposing writes; reject escapes and
  unsupported names rather than mapping them ambiguously. Do not claim a server
  sandbox merely because the UI selected a folder.
- Enumerate lazily and read in bounded chunks, with bounded workers and caches.
  No whole-tree pre-scan or arbitrary total file/depth cap. Define cache expiry
  and refresh behavior when another remote client modifies files.
- Start with acknowledged writes and no offline write-back. Surface timeouts,
  permission failures and failed writes to the calling app. Report flush according
  to the negotiated provider capability; an SFTP acknowledgement alone is not a
  promise of stable disk persistence. Do not defer fallible uploads until close,
  where the OS callback may be unable to return the error to the application.
- Network loss leaves a visibly offline mapping with bounded I/O failure, not
  an Explorer freeze. Reconnection must revalidate identity; never automatically
  replay an ambiguously completed mutation.
- Closing a Files window does not detach the drive. Normal detach drains writes
  and reports busy handles. Quitting ShellCanvas must handle active mappings
  explicitly; silent forced detach and automatic startup mounting are out of scope
  for the first release.

## User flow

1. Folder/volume context menu: **Attach to this computer…**.
2. Dialog shows host and remote path, local target, access mode and any missing
   native component. Installation is a deliberate setup action.
3. Settings → Files shows host, remote/local path, access and attachment state,
   with explicit Detach, Open folder, Retry cleanup and completed-result Dismiss
   actions. Failed setup must leave no
   phantom drive; unconfirmed cleanup remains visible.
4. Disconnect/quit explains which mappings are affected and allows cancellation
   when files remain in use.

## Delivery gates

- **BRIDGE-01 — Windows proof.** Select and validate the WinFsp native Rust binding
  and licensing; build a read-only SFTP mapping against a disposable directory on
  an existing host. Verify Explorer enumeration, large-file seek/read, hashes,
  Unicode paths and connection loss. This is an engineering milestone, not the
  completed end-user feature.
- **BRIDGE-02 — First usable release.** Implement write/create/truncate/replace,
  clear unsupported-operation errors, context-menu setup, mapping management,
  bounded caching and safe detach/quit. Test an ordinary editor and Office-style
  temporary-file/rename saves, simultaneous handles, remote changes, disk-full and
  permission errors, interrupted writes, case-sensitive name collisions and
  reconnect identity changes. Compare resulting remote bytes. Do not promise
  database, VM-image or distributed locking compatibility without specific tests.
- **BRIDGE-03 — Other client OSs.** Implement Linux and macOS backends after the
  shared contract is exercised. Test the exact supported runtime/OS combinations;
  decide Catalina support independently from its remote-host support.
- **BRIDGE-04 — Extension access.** Exercise a second Files provider and only then
  expose the needed optional native-adapter methods. Consider an app management
  API with explicit grants, without granting web apps arbitrary OS mounting.

The design assessment installed no driver or remote software. Subsequent live
implementation tests use newly created disposable directories; see the checkpoint
for evidence and unfinished release gates. Native Windows API tests now pass with
WinFsp on disposable CI runners; driver setup on the developer PC and desktop UI
acceptance remain pending.
