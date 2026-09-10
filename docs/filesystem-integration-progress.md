# Filesystem integration implementation checkpoint

Updated 2026-09-11. Goal remains active. This is not a release/completion claim.

## Accepted scope

Implement optional core filesystem operations and machinery, with Windows
WinFsp and Linux/macOS FUSE backends where supported. Modern client systems are
the priority. The user's later decision makes the driver-facing bridge a separate
public, free app; the core must not depend on third-party filesystem drivers.
Include the dependencies' licensing/distribution limitations in that app.

## Current implementation

- Unconfirmed SFTP CLOSE now retains cleanup ownership in a guard until the
  server acknowledges success. Caller cancellation, rejection, timeout, or a
  dropped cleanup task retires the mount's dedicated channel, releasing remote
  handles instead of leaving the mount healthy with an untracked ID. The
  cancellation regression failed before this fix and now passes. Protocol
  fixtures additionally verify successful CLOSE keeps its channel available,
  and cancelled file/directory OPEN closes a late returned handle. All 37 core
  unit tests and core lint checks pass; no SDK or wire changes were required.
- Native Linux 6.8 FUSE acceptance as UID 65534 now covers a deliberately stalled
  dedicated SFTP stream while SSH and bridge IPC stay healthy. The local
  synchronous write reports ETIMEDOUT within the asserted 25-second deadline;
  close reports failure, the helper exits with failure, and the mount is removed
  before recovery. Independent backing-file inspection confirms prior bytes
  remain intact, and the other SFTP channel still lists the source afterwards.
  This uses bridge `0bf4b9a` from CI `34528217955`, SHA-256
  `1e605de4345c8b13b20c033d52cb34d0a7e5ad17d4d90b21e85fd57242aea1f2`.
  Fixture `194e224f-5e6e-4ea3-93e5-b7220a22054e` and staged binary directory removal
  were independently verified. `SHELLCANVAS_PROBE_SFTP_STALL=1` injects dropped
  SFTP traffic only in the opt-in probe; it does not change host networking.
  Full TCP-network blackholes and remote disk-full behavior remain separate gates.
- Windows creation/overwrite read-only projection passes at bridge `0bf4b9a`,
  CI `34528217955` (native suite 28.95 seconds). The original creating/overwriting
  handle can finish writing; later writes are blocked by the read-only flag.
  CopyFileW of a read-only source preserves its flag and exact backing bytes.
  Unsupported hidden creation leaves no entry, and unsupported overwrite does
  not truncate the destination. The overwrite test uses `NtCreateFile` with
  `FILE_OVERWRITE`, verified against a local Windows baseline; the ordinary Rust
  reopen/truncate path does not forward supplied attributes to this callback.
  Archive flags supplied during create/overwrite are advisory and not persisted;
  other unsupported DOS flags are rejected before mutation. A post-create
  metadata failure returns an error and warns about the possibly created entry,
  rather than deleting a path another remote actor might have replaced.
  All platform builds/tests, local Windows lint checks and prior native lifecycle
  checks pass. No new required provider methods or protocol fields were added.
- Ordinary Windows `CopyFileW` acceptance passes at bridge `f6e3ee8`, CI
  `34526423658` (native suite 29.44 seconds): both copy directions, exact backing
  bytes, modification-time preservation, exclusive creation and overwrite.
  CopyFileW bundles metadata-change time with modification time and ignores a
  rejected metadata update. The bridge therefore preserves supported access/
  modification times in that combination, omits unavailable change time, and
  warns the parent once per attachment. Change-time-only, creation-time and
  pre-epoch requests still fail. This supersedes the earlier blanket rejection
  of all mixed change-time requests below; it does not add new timestamp fields.
- The core SFTP probe now separately verifies initial read-only permissions and
  combined truncation/permissions while retaining the original writable handle.
  Live acceptance on the authorized Linux test host passed; removal of disposable fixture
  `e6cbf9a3-e45a-4e57-b3d5-2a83cb526056` was independently verified. This is provider
  evidence, separate from native Windows and desktop-created mapping acceptance.
- Windows timestamp handling is verified at bridge `3f66501`, CI run
  `34524595837` (native suite 29.14 seconds). Missing creation/change timestamps
  remain unavailable instead of copying modification time; missing/out-of-range
  provider timestamps are not fabricated. Access/modification updates use the
  contract's whole-second precision. Unsupported creation/change-only updates and
  pre-Unix-epoch dates fail before other metadata is changed. Native WinFsp
  verifies round-trip access/modification times and unchanged backing timestamps
  and permissions after rejected mixed requests; prior native checks pass.
  Linux/macOS builds/tests and Windows clippy pass. The live core SFTP probe also
  passes single-field time updates preserving the other timestamp and rejection
  of a date beyond SFTP v3's range with no partial permission change. Disposable
  fixture `6862dc70-0b9b-482e-b09d-40c131de09b2` removal was independently verified.
  This does not add creation/change-time storage to providers lacking it.
- Windows existing-file read-only attributes now project through remote Unix
  permission bits at bridge `447b1c3`. Set removes write bits; clear restores owner
  write only. `SetBasicInfo` rejects unsupported DOS flags before mutating other
  metadata. It also rejects unsupported directory/special-mode transitions.
  Attribute-only opens request a remote read handle instead of data-write access.
  The core permits non-size metadata changes on read handles within writable
  roots; read-only roots and read-handle truncation remain rejected. No new
  required provider methods or protocol fields were added.
  Core 34 tests and both core/bridge clippy pass. Live SFTP `mount_probe` passes
  permission set/clear via a read handle, rejected truncation and read-only-root
  enforcement; fixture `aa48fc99-234b-412a-80e6-5b984c1cbcb6` removal was independently
  confirmed. CI `34523633220` passes all platforms and native WinFsp acceptance
  (37.15 seconds): read-only set/clear reaches backing metadata, new writes and
  deletion are blocked, and combined hidden/read-only rejection has no partial
  effects. This is separate bridge/provider evidence, not a desktop SFTP mapping.
  Creation/overwrite attributes remain open; later timestamp handling is above;
  arbitrary DOS flags are not persisted by the present portable contract.
- FUSE inode lifetime coverage passes at bridge `558d1f2`, CI run
  `34521983619`: lookup and open references retain an inode until both are gone,
  in either cleanup order; retiring an old inode cannot remove a recreated path.
  Its Linux artifact (SHA-256
  `f13570f87abe01de5268eedb96de86ae52e9c0eb43f76c712042a6b70dc980ec`)
  also passes native Linux 6.8 acceptance as UID 65534 through the core SFTP
  provider. Unlinking an open file and recreating its path yields a distinct inode;
  the old descriptor still reads/writes the old object and its close leaves the
  replacement intact. Source-owner inspection independently verifies replacement
  bytes. Prior directory rewind, mmap, busy detach and ordinary unmount checks
  pass. Fixture `62945821-3521-4387-bae4-d16d1117b9f7`, mount and staged binary
  were independently confirmed removed. All platform CI jobs pass, including
  native Windows acceptance (29.24 seconds). This closes the inode retention/forget
  coverage item; it does not establish concurrent edits by another remote client.
- Native Windows volume-wide flush now passes at bridge `9c4fbe1`, CI run
  `34521265017` (full native suite: 28.88 seconds). The fixture opens the actual
  disposable volume through the Windows device path and calls FlushFileBuffers
  via `File::sync_all`. All three writable files are attempted even when one
  provider flush fails; Windows receives ERROR_IO_DEVICE. Clearing the injected
  fault allows the next volume flush to succeed, with every file's backing bytes
  independently verified. All platform builds/tests and prior native checks pass.
- Native Linux 6.8 acceptance now also passes as the existing unprivileged
  account `nobody` (UID 65534), using bridge `87a28c9`. The opt-in harness mode
  `SHELLCANVAS_PROBE_UNPRIVILEGED=1` runs the bridge and local file operations
  without root. The source owner independently verifies confirmed backing bytes.
  File operations, directory rewind/rename, mmap, busy-detach protection and
  ordinary unmount pass. A second run with `SHELLCANVAS_PROBE_TRANSPORT_LOSS=1`
  returns ENOTCONN for write/close, preserves confirmed source data, reports a
  failure exit and removes the mount before privileged recovery is attempted.
  Both disposable fixtures (`ed155bc7-c391-4767-927d-9b0018847016` and
  `882ecebf-e1b7-4adf-a56b-7f56686a6afb`) and the staged binary were independently
  confirmed removed. No accounts, FUSE configuration or driver setup changed.
- Bridge `87a28c9` fixes FUSE directory rewind recovery: retired handles and
  buffered entries are cleared before reopening. A failed close/reopen or invalid
  reply cannot leave a later seek using a closed handle. Two regression tests
  pass on Linux/macOS in CI run `34519068114`; all platform jobs pass. Its Linux
  artifact (SHA-256 `24babf890037503ae93d3f2ac7c8ee855b9e4a093208d82f9b8a30c155bc515a`)
  passes native Linux 6.8 acceptance over the real core SFTP provider: the same
  directory descriptor enumerates exact pages after repeated rewind and after
  directory rename. Prior I/O, mapped-file and busy-detach checks also pass.
  The fixture `d7d47df5-69e2-4b6b-a9b6-70e2b6615214` and staged binary directory
  were independently confirmed removed, with no remaining mount-table entry.
  Failure recovery is regression-fixture evidence; native injected reopen failure
  remains a separate check; non-root acceptance is recorded above.
- Bridge `e58d386` passes native Windows acceptance in CI run `34518237898`
  (32.21 seconds), including directory rename with two open directory aliases.
  An open descendant correctly blocks rename with error 5 and preserves source
  contents/handles; after closing the child, rename succeeds and both directory
  handles still return metadata. Replacing a nonempty destination is rejected
  without damaging either tree. A separate local NTFS baseline and Microsoft's
  MS-FSA FileRenameInformation specification confirm that the open-child rule
  differs from POSIX. The first test expected POSIX behavior and failed; its
  Windows expectation was corrected, with no driver behavior changed. All prior
  native Windows acceptance markers and Linux/macOS builds/tests also pass.
- Windows attachment setup now offers only unused D: through Z: drive letters,
  also excluding active ShellCanvas reservations. The backend still checks the
  chosen location at attachment time. Synthetic browser checks confirm the first
  available choice and the disabled/explained no-free-letter state. TypeScript
  and desktop clippy pass. Bridge `49c481a` explains missing/damaged WinFsp with
  official setup guidance. A real helper launch on this PC without WinFsp passes:
  after the protocol capability handshake it exits promptly with that message,
  without requesting filesystem operations. No driver was installed. This does
  not replace the full desktop installation and mapped-drive checks below.
- `crates/filesystem-sdk`: small MPL-2.0 optional rooted filesystem contract and
  inherited-pipe protocol. Validated relative components, metadata/capacity,
  handle-based offset I/O, truncate, flush, atomic replacement, incremental
  directories, errors and handle cleanup. No driver or SSH dependency.
- `FileSystemProvider` has optional `supports_local_mount` / `mount_root` defaults.
  Existing providers do not need to implement them. Sequential transfer semantics
  remain unchanged.
- SFTP implements the contract. An SSH attachment uses a dedicated SFTP channel
  on the accepted connection. Read-only grants are enforced at the provider.
  No special daemon, script or mount utility is needed on the remote file host.
- Desktop Files bindings forward the optional mount capability. Mounted files and
  directories capture that binding; retirement rejects further I/O and reports
  uncertain in-flight writes, while close still targets the original handles.
  Heartbeats check binding health. Whole-grant handle teardown and blocked reply
  writes have bounded deadlines.
- Public repository: https://github.com/techartdev/ShellCanvas-DriveBridge,
  initial commit `0cc04ad2e0c31f7e30e39960ea9536e0d0d324f9`.
  Follow-up `dac05fa` adds executable help/notices, build/native-test status,
  binding health and bounded protocol cleanup. Published on `main`.
  Canonical source repository: `ShellCanvas-DriveBridge`, maintained separately from this desktop checkout.
  `.local/drive-bridge` is the initial build staging copy, not the canonical repo.
- Public review branch `feat/graceful-detach` now includes `078e624`:
  Windows volume flush visits all writable descriptors and reports the first
  failure after attempting the others. Confirmed renames update related open
  paths; failed renames preserve them. Dropping an open context closes remote
  handles, including failure after acquisition. Two bookkeeping regressions pass;
  Windows and Linux clippy pass. Native coverage is described below; these
  specific failure/volume-flush/cross-handle cases still need native acceptance.
  These changes are in PR #1, not public main; protocol v2 still awaits merge.
  CI run `34507333272` for `078e624` passed builds and tests on Windows,
  Ubuntu and macOS 14. This is build evidence, not native Windows/macOS mount evidence.
- Bridge `da6cf5a` negotiates Linux `FUSE_DIRECT_IO_ALLOW_MMAP` only when the
  kernel advertises it, preserving ordinary direct I/O without enabling generic
  writeback caching. CI run `34509574335` passed all three platforms. Its Linux
  binary (SHA-256 `dac610e7588bf33d53e69f4896cfec8b3a6395cab892e5b42a500a8280415a6d`)
  passed native Linux 6.8 tests through the core SFTP root: shared cross-page
  mapped writes flushed to the independently inspected source, mapped lifetime
  after descriptor close, read-only maps and private copy-on-write isolation.
  The full prior native file-operation/busy-detach suite also passed, followed
  by ordinary unmount and removal of the disposable UUID tree. The harness is
  `crates/ssh-core/examples/native_bridge_probe.rs`.
- Bridge has native Windows callbacks and a shared Linux/macOS FUSE backend,
  plus an independently buildable vendored SDK. GPL-3.0-only bridge licensing
  leaves the main app MPL-2.0. README/THIRD-PARTY describe WinFsp/wrapper terms,
  separate macFUSE installation and commercial binary-bundling restrictions.
- Bridge `30c4125` passes native WinFsp 2.1.25156 acceptance in CI run
  `34511425152`, Windows job `102986233383`. The opt-in `tests/native_windows.rs`
  launches the real executable and mounts an unused drive letter over a disposable
  local provider. Windows file APIs verify offsets above 4 GiB, flush/truncate,
  temporary-file replacement saves, exact directory enumeration across pages,
  rename/deletion, missing/denied/nonempty errors and provider capacity. Shared
  cross-page mapped writes reach the independently inspected source; mappings
  survive descriptor close; read-only and private copy-on-write maps pass.
  A held file prevents detach; an explicit retry after close removes the drive.
  All four native markers pass, with one test passing in 27.93 seconds. Windows,
  Ubuntu and macOS 14 build/test jobs pass. This is real WinFsp acceptance with
  a local provider, not desktop UI or an end-to-end SFTP mapping test.
- Follow-up bridge `36464c5`, CI run `34512537189`, passes native Windows failure
  injection as well (28.21 seconds). Write-through writes surface the expected
  Windows status for I/O failure, offline, timeout and read-only rejection;
  independently inspected source bytes remain unchanged. Failed durable flush
  reports an error. Unrelated I/O remains usable after these operation failures.
  Failed close and cleanup-time deletion deliver structured warnings to the parent;
  failed deletion preserves the source. This injects provider errors, not a real
  network outage or exhausted remote disk. Prior native checks continue to pass.
- Bridge `1459801`, CI run `34513391440`, passes actual Windows pipe-loss acceptance
  (31.50 seconds for the full test). With a write-through file still open, both
  parent pipe endpoints are dropped. The next write fails within ten seconds,
  independently inspected confirmed source bytes remain unchanged, the helper
  exits unsuccessfully and the drive letter disappears. Unexpected lifecycle
  replies/connection loss now return failure exits on both Windows and FUSE;
  ordinary explicit detach remains successful. All three platform CI jobs pass.
  This tests abrupt bridge IPC loss, not an actual SSH network outage.
- The same `1459801` Linux artifact (SHA-256
  `4c759947a074c87ff29c10467afdf02961b4fb5e5938875c9f350ea970925882`)
  passes native Linux 6.8 bridge-transport-loss acceptance over the core SFTP
  provider. A local file is held open after a confirmed write/fsync, then both
  bridge pipes are closed. The next write and final close report ENOTCONN (107),
  source bytes inspected through an independent SSH command remain `confirmed`,
  the bridge exits unsuccessfully and `/proc/self/mountinfo` shows the mount
  removed. The fixture and staged binary were separately confirmed removed.
  Reproduce the existing `native_bridge_probe` with both
  `SHELLCANVAS_LIVE_MOUNT_PROBE=1` and `SHELLCANVAS_PROBE_TRANSPORT_LOSS=1`.
  Its cleanup now consults mountinfo even when a disconnected mount rejects stat.
  The first attempt exposed a test expectation issue: close also returned the
  connection error; after explicitly validating that result the full replay passed.
  Example compilation/clippy pass. This verifies the Linux 6.8/root runtime used;
  modern macOS and actual SSH outages remain separate; non-root Linux is verified above.
- Native Linux controlled SSH-disconnect acceptance exposed and fixed a heartbeat
  gap: failed file I/O did not itself make the underlying SFTP mount's cheap health
  check fail. Production SSH mounts now retain the exact original connection's
  lifecycle and report Offline when it closes, without resolving any new source.
  `SHELLCANVAS_PROBE_SSH_LOSS=1` closes only the fixture's SSH source connection;
  the bridge pipes and independent test-control SSH sessions remain available.
  Before the fix, the helper missed its exit deadline. After the fix, live Linux
  FUSE write/close return EIO, source bytes remain `confirmed`, the heartbeat reports
  the closed SSH connection, the helper exits unsuccessfully and mountinfo shows
  removal. Both the failing and passing disposable fixtures and the staged binary
  were independently confirmed removed. All 33 core tests and all-target clippy
  pass. This is a controlled real SSH disconnect, not a black-holed network or a
  silent SFTP-only channel close; those failure detection paths remain to verify.
- Desktop SFTP channels now observe their own transport EOF, I/O errors, shutdown
  and drop, without additional remote probes. Mount heartbeat checks report Offline
  after channel retirement even if the SSH connection remains open. Unconfirmed
  OPEN/OPENDIR timeout also marks that same channel retired before closing it.
  A real SFTP framing fixture closes one idle channel while a second remains open:
  the first bridge Poll reports Offline and the second continues successfully.
  The timeout fixture also verifies that heartbeat health is retired. All 34 core
  unit tests and all-target clippy pass. Live `mount_probe` still passes offsets
  above 4 GiB, truncate/EOF, concurrent handles, atomic saves, read-only grants,
  directory enumeration and disposable cleanup. This is channel-close protocol
  evidence plus a live healthy-path regression; native channel-only loss and
  stalled-network detection remain separate checks.
- SFTP handle acquisition now closes the mount's dedicated channel if OPEN or
  OPENDIR times out before the handle ID arrives. This releases potentially
  allocated but unclaimed server handles without replaying CREATE. Native library
  timeouts are classified as TimedOut. A paused-clock test exercises real SFTP
  framing over an in-memory connection: file/directory acquisition and the library
  deadline each produce channel EOF while the service is still alive. Actual
  network-loss and caller-cancellation acceptance remain separate checks. All 33
  SSH core unit tests and core all-target clippy pass after this change.
- Main desktop has reviewed optional bridge installation in Settings → Files.
  The native chooser stages exact bytes; approval is window-owned, single-use and
  expires. Installed versions are immutable content-addressed files under the
  app data directory, with atomic selection and hash verification before launch.
  The UI describes native-code trust and driver/license terms. Installation tests
  use isolated temporary profiles; no bridge was installed into the user's profile.
  Three installer tests pass, including changed-review rejection preserving the
  previous installation. Frontend production build, desktop clippy and 640px
  preview overflow checks pass. Native chooser/approval still needs end-to-end use.
  Native chooser/approval and an actual desktop-launched Windows mapping remain
  unverified; the implementation is a development preview.
- Files now offers **Attach to this computer…** for folders/current directories,
  and an Attach action beside mounted volume locations. The dialog checks optional
  provider support and installation, defaults to read-only, offers a Windows drive
  letter or a native empty-folder chooser on Unix, and shows attachment status.
  Settings → Files lists mappings and their host/path, warnings and detach actions.
  Compact 400px light and normal-width dark dialog layouts were checked with a
  synthetic UI fixture; these checks did not create an OS mount.
- The desktop mapping manager reserves the exact session/source before opening
  a rooted grant, retains a connection lease, launches only a hash-verified installed
  helper and supervises it over inherited pipes. It bounds startup, stderr memory,
  failed-process cleanup and handle teardown. Closing Files or switching visible
  hosts does not stop or retarget a mapping. Disconnect/source replacement and
  remote-volume unmount refuse while affected mappings run; quit opens Settings
  with an explanation. Failed disconnect no longer marks a retained workspace
  disconnected in the UI. Busy detach never kills or retries the helper.
  Unconfirmed process cleanup conservatively retains the grant/connection guard
  and shows a warning; automatic recovery from that state is not yet implemented.
  The core also enforces read-only grants/handles independently of provider write
  behavior. Installed bytes are checked again immediately before helper launch.
- Protocol v2 adds ready/status/warning events and an explicit detach request.
  A failed busy detach returns to Attached and requires a new request; it never
  automatically retries. Windows holds an open-context gate across detach; Linux
  and macOS explicit Detach uses ordinary system unmount without force/lazy flags.
  Abnormal FUSE session/process cleanup also invokes the library's own teardown;
  `fuser` 0.18's fallback can use lazy/forced unmount. Its native failure path remains
  a verification gate, distinct from the normal busy-detach evidence. Windows cleanup
  failures reach the parent as structured warning events displayed by the mapping
  manager. Lifecycle and Windows gate unit tests pass.
- Public bridge PR https://github.com/techartdev/ShellCanvas-DriveBridge/pull/1
  contains the detach changes. Native Linux acceptance passed against `32d0c79`:
  held file prevented unmount, attachment remained usable, releasing it allowed
  an explicit clean detach, and the full file-operation/cleanup test passed.
  Review-branch commit `6edb2a9` adds structured cleanup warnings and
  retired-channel refinements. All Windows/Ubuntu/macOS 14 checks pass on that
  commit (run `34502539007`); the PR is ready but requires repository review.
  Main `dac05fa`
  remains protocol v1 until this PR merges; use a v2 bridge with the updated core.

## Evidence gathered

- `cargo check -p shellcanvas-core` passes.
- `cargo clippy -p shellcanvas-core -p shellcanvas-filesystem-sdk --all-targets -- -D warnings` passes.
- Five filesystem SDK tests pass: path validation, bounded frames, exact large
  offsets, transport retirement on a mismatched reply and explicit busy detach.
- Four desktop mapping tests pass, including connection lease ownership and an
  opt-in native child-process fixture. On Windows the fixture verifies that a
  stalled startup and invalid protocol are terminated/reaped, 160 KB of stderr
  does not block the protocol, busy detach retains the helper, and a second explicit
  detach completes. It uses no driver and performs no local/remote file operations.
  Reproduce with `cargo build -p shellcanvas-filesystem-sdk --example lifecycle_fixture`,
  set `SHELLCANVAS_BRIDGE_FIXTURE` to that absolute executable, then run
  `cargo test -p shellcanvas --lib drive_mappings::tests -- --include-ignored`.
- Thirty frontend service/session/app-boundary tests pass, including source pins
  on the new attach/availability commands. Desktop clippy and frontend type-check
  pass. The production frontend build passes (the existing large-chunk advisory
  remains); this does not verify a native mounted drive.
- Opt-in `mount_probe` on the authorized Linux SSH host passes real SFTP tests:
  offsets above 4 GiB using a sparse file, truncation, EOF, atomic save replacement,
  old/new open-handle identity, close, read-only enforcement, directory listing
  and removal of its disposable UUID directory.
- Opt-in `bridge_probe` passes with the independently compiled Windows executable:
  native process → inherited pipes → core root grant → real SFTP. Offset I/O,
  flush, truncate, rename, closed-handle refusal and disposable cleanup pass.
- Windows bridge builds; Linux `cargo check` and `cargo clippy -- -D warnings`
  pass with `x86_64-unknown-linux-gnu`. Neither is a native mounted-drive test.
- GitHub Actions run `34496246842` completed successfully for the initial public
  commit on Windows, Ubuntu and macOS 14. This verifies compilation, not native
  mounted-drive behavior on Windows/macOS.
- All 32 SSH core unit tests and 16 desktop workspace-binding tests pass, including
  retirement/cleanup/error preservation for mounted handles. Desktop library
  compilation passes.
- Native Linux mount checks pass through the CI-built FUSE executable, a pipe
  relayed over SSH, the Windows core and real SFTP. Verified sparse offsets above
  4 GiB, truncate, replacement saves with old handle identity preserved, a 70-file
  directory spanning pages, directory rename with an open file, capacity and
  missing/nonempty errors. Ordinary unmount succeeded. This deliberately relayed
  test has extra network round trips and is not a production performance baseline.
  The first test timed out creating files; the next passed filesystem checks but
  exposed a harness cleanup bug (normal Files deletion only accepts empty folders).
  Both disposable fixtures were subsequently confirmed unmounted and removed.
  `native_bridge_probe` now uses an explicit bounded remote timeout and scoped
  recursive cleanup of its own UUID fixture. Final replay passed end to end,
  including ordinary unmount and confirmed removal of the entire disposable tree.
- The Linux test host already has `fusermount3`, `fusermount` and `/dev/fuse`.
  Its ordinary PATH has no cargo/rustc/gcc. Prefer a CI-built binary for a
  disposable FUSE test rather than changing the server's installed toolchain.
- Verified the official WinFsp 2.1.25156 MSI signature (Navimatics). Installation
  failed with Windows Installer 1925 / exit 1603: administrator privileges needed.
  No successful driver installation on this PC has been established. CI now
  installs the official runtime on its disposable Windows runner, checking the
  pinned MSI SHA-256 and Authenticode signer before native tests. The local UAC question
  is pending. This is an OS privilege issue, not an automatic approval rejection.
  Installer/log are under `.local/bridge-tools`. Workspace-only libclang 18.1.1
  is available at `.local/bridge-tools/python/clang/native` for Windows builds.

## Client boundary and desktop wrapper follow-up

The desktop mounted-filesystem wrapper now permits timestamp/permission changes
through read handles on writable mounts, matching the provider contract used by
Windows attribute-only opens. Truncation still requires a writable data handle;
read-only mounts and retired workspace bindings reject changes before reaching
the provider. The production wrapper regression test passes locally.

Runtime app manifests now declare optional client platform compatibility. The
package manager enforces it for installs, updates, enabling, and launch, and the
SDK exposes client identity independently of the remote host. Drive Bridge also
gates its native installation and attach commands to Windows/Linux/macOS clients.
See [client platform compatibility](client-platform-compatibility.md) for the
contract and deferred mobile work. This does not claim an Android/iOS app build.
Local SDK packaging/schema tests, targeted catalog/runtime tests, native bridge
installation/reservation tests, and the production frontend build passed. No CI
run was triggered for this follow-up. Batch future CI changes and use local
verification where possible to respect the user's GitHub plan.

## Startup cancellation follow-up

Attachment preparation now exposes **Cancel attachment** while opening the
remote root or verifying the local executable. Cancellation drops preparation
resources and never starts the native helper. A serialized launch boundary
rejects a late cancel request; once native startup begins, the existing detach
and recovery machinery retains ownership. Canceled entries are labeled Canceled
and can be dismissed after their connection reservation is released. Root
availability is rechecked after executable verification, before native launch.
This adds no filesystem-provider or bridge-protocol requirement.

Local verification covers cancellation before polling, during preparation, and
as a ready result arrives; the production desktop `run` path verifies no helper
starts and root resources are dropped. The SFTP wire fixture cancels REALPATH and
LSTAT during root preparation, observes channel EOF, and confirms another channel
remains open. The isolated browser fixture verifies Cancel → Canceled → Dismiss
and the rendered dialog. These are synthetic lifecycle/UI checks, not evidence
of a desktop-created WinFsp mount.

The ignored native-helper acceptance test was explicitly run locally with the
built `shellcanvas-filesystem-sdk` `lifecycle_fixture` example. Stalled startup,
invalid protocol, retained reservation for an occupied system location (read-only
occupancy inspection), busy-detach refusal and explicit retry all passed. No
driver, remote account, normal app profile, or CI run was used by these checks.

## Remaining completion gates

1. Native end-to-end installation verification and an actual desktop-created
   mapping, including chooser cancel, missing driver and changed executable.
   The manager/UI/source leases are implemented; native user-flow verification
   remains, including disconnect/source replacement/quit with busy local files.
2. Open folder and explicit Retry cleanup controls are implemented. Retry retains
   the original helper/job ownership and connection reservation. After process
   shutdown, native OS mount-table checks must confirm the location is unmounted;
   if not, the UI asks for system unmount followed by another explicit check. No
   force/unmount command is added to the core. The native helper fixture proves
   a stopped process does not release a still-occupied location. Native Windows
   mount-table and Linux parser tests pass; Linux/macOS mount-table code compiles
   separately for those targets. Open/retry/dismiss UI checks pass at normal dark
   and 400px light layouts with synthetic data. Desktop clippy and production
   build pass. Full desktop mapping recovery remains part of gate 1, including
   the platform launcher and native Unix mount-table runtime checks.
3. Broaden failure acceptance to full TCP-network blackholes, remote-initiated
   native SFTP-only EOF and remote permission/disk-full errors. A stalled SFTP
   channel with healthy SSH now passes native acceptance as recorded above.
   Idle channel EOF now has
   protocol-level coverage with a second unaffected channel. Controlled SSH disconnect now
   passes over a native Linux mount, after fixing its connection-bound heartbeat.
   Native provider error/cleanup warning injection now passes. Unconfirmed
   SFTP open timeout cleanup and late OPEN reply cancellation are protocol-fixture
   tested. Cancelled/timed-out/rejected CLOSE cleanup is fixed and verified above.
   Cancellation while preparing the root is now verified above. The native
   chooser/source-retirement race remains to be exercised without touching the
   normal user profile.
4. Native Windows file API, replacement-save, capacity, basic error and busy-detach
   checks now pass in disposable WinFsp CI. Remaining: desktop-created SFTP mapping,
   Explorer/ordinary editor acceptance (native directory rename/open-handle
   semantics are now verified above),
   disconnect behavior and failure recovery. Local driver setup is still pending.
5. Native Linux FUSE file operations, directory rewind/rename, truncate, flush,
   mapped files, busy detach and ordinary unmount now pass as root and as an
   unprivileged user on Linux 6.8. Pipe loss with an open file also passes in both
   contexts, including source preservation and confirmed mount disappearance.
   Inode retention/forget coverage now passes as recorded above.
   Remaining: the permission-error matrix and
   other supported runtimes. Do not infer those from one kernel/runtime.
6. Verify modern macOS compilation and native runtime as available. fuser's
   kernel/libfuse backend is implemented; FSKit operation is not established.
   Do not claim an OS version/runtime works solely because Linux compiled.
7. Resolve currently documented limits before calling the release ready:
   Windows cleanup-time deletion warnings and busy-detach control are implemented
   with busy detach now passing native WinFsp acceptance. Cleanup-time failure
   warnings now pass native failure injection. Volume-wide flush and cross-handle rename
   are implemented with bookkeeping regression tests. Native directory alias
   rename and volume-wide flush checks now pass. Existing-file read-only changes
   now pass native Windows and separate live SFTP checks. Timestamp mapping and
   explicit rejection of unavailable creation/change-only updates pass as recorded
   above. Creation/overwrite read-only handling and ordinary native copy now pass
   as recorded above; full DOS-attribute/ACL persistence is not provided.
   Linux shared/private/read-only memory-mapping acceptance
   passes, as does Windows shared/private/read-only mapping against a disposable
   local provider. macOS mapped-file tests and concurrent remote-edit behavior
   remain unverified. This is not database or VM-image compatibility evidence.
8. Review cancellation/late responses, bounded teardown and protocol errors with
   failure fixtures, then run the relevant core/desktop regression checks. Add
   reproducible release packages/notices and update bridge docs with exact verified
   platforms. Do not represent an unsigned preview binary as a supported release.

Preserve pre-existing theme changes in this worktree. The normal app profile and
the unrelated assistant repository were not modified by this implementation pass.
