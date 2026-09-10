# Filesystem integration implementation checkpoint

Updated 2026-09-10. Goal remains active. This is not a release/completion claim.

## Accepted scope

Implement optional core filesystem operations and machinery, with Windows
WinFsp and Linux/macOS FUSE backends where supported. Modern client systems are
the priority. The user's later decision makes the driver-facing bridge a separate
public, free app; the core must not depend on third-party filesystem drivers.
Include the dependencies' licensing/distribution limitations in that app.

## Current implementation

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
  Canonical local checkout: `D:\Mine\ShellCanvas-DriveBridge`.
  `.local/drive-bridge` is the initial build staging copy, not the canonical repo.
- Public review branch `feat/graceful-detach` now includes `078e624`:
  Windows volume flush visits all writable descriptors and reports the first
  failure after attempting the others. Confirmed renames update related open
  paths; failed renames preserve them. Dropping an open context closes remote
  handles, including failure after acquisition. Two bookkeeping regressions pass;
  Windows and Linux clippy pass. Live WinFsp acceptance remains required.
  These changes are in PR #1, not public main; protocol v2 still awaits merge.
- Bridge has native Windows callbacks and a shared Linux/macOS FUSE backend,
  plus an independently buildable vendored SDK. GPL-3.0-only bridge licensing
  leaves the main app MPL-2.0. README/THIRD-PARTY describe WinFsp/wrapper terms,
  separate macFUSE installation and commercial binary-bundling restrictions.
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
  and macOS use ordinary system unmount without force/lazy flags. Windows cleanup
  failures reach the parent as structured warning events displayed by the mapping
  manager. Lifecycle and Windows gate unit tests pass.
- Public bridge PR https://github.com/techartdev/ShellCanvas-DriveBridge/pull/1
  contains the detach changes. Native Linux acceptance passed against `32d0c79`:
  held file prevented unmount, attachment remained usable, releasing it allowed
  an explicit clean detach, and the full file-operation/cleanup test passed.
  Latest review-branch commit `6edb2a9` adds structured cleanup warnings and
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
  No successful driver installation has been established. The async UAC question
  is pending. This is an OS privilege issue, not an automatic approval rejection.
  Installer/log are under `.local/bridge-tools`. Workspace-only libclang 18.1.1
  is available at `.local/bridge-tools/python/clang/native` for Windows builds.

## Remaining completion gates

1. Native end-to-end installation verification and an actual desktop-created
   mapping, including chooser cancel, missing driver and changed executable.
   The manager/UI/source leases are implemented; native user-flow verification
   remains, including disconnect/source replacement/quit with busy local files.
2. Add mapping Open-local-location convenience and an explicit recovery workflow
   for unconfirmed cleanup. Do not silently clear ownership or claim detach.
3. Broaden failure acceptance to real network loss, permission/disk-full errors,
   late SFTP open responses and cancellation while preparing the root. Verify the
   native chooser/source-retirement race without touching the normal user profile.
4. Native Windows mount tests after administrator setup: Explorer and actual
   local file APIs, ordinary editor/temporary-file replacement saves, directory
   rename with open handles, capacity, errors and disconnect behavior.
5. Native Linux FUSE tests using a CI binary and a disposable directory. Validate
   directory cursor/rewind and inode retention/forget behavior, create/rename/
   truncate, permissions, flush, detach and helper failure.
6. Verify modern macOS compilation and native runtime as available. fuser's
   kernel/libfuse backend is implemented; FSKit operation is not established.
   Do not claim an OS version/runtime works solely because Linux compiled.
7. Resolve currently documented limits before calling the release ready:
   Windows cleanup-time deletion warnings and busy-detach control are implemented
   but need native WinFsp acceptance. Volume-wide flush and cross-handle rename
   are implemented with bookkeeping regression tests; native checks and file
   attribute work remain. Memory-mapped workflows need explicit acceptance.
8. Review cancellation/late responses, bounded teardown and protocol errors with
   failure fixtures, then run the relevant core/desktop regression checks. Add
   reproducible release packages/notices and update bridge docs with exact verified
   platforms. Do not represent an unsigned preview binary as a supported release.

Preserve pre-existing theme changes in this worktree. The normal app profile and
the unrelated assistant repository were not modified by this implementation pass.
