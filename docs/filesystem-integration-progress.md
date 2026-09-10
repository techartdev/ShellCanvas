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
- Bridge has native Windows callbacks and a shared Linux/macOS FUSE backend,
  plus an independently buildable vendored SDK. GPL-3.0-only bridge licensing
  leaves the main app MPL-2.0. README/THIRD-PARTY describe WinFsp/wrapper terms,
  separate macFUSE installation and commercial binary-bundling restrictions.
- Main desktop storage/settings/installation and right-click attachment UI are
  **not integrated yet**. No user mapping is active or advertised as ready.

## Evidence gathered

- `cargo check -p shellcanvas-core` passes.
- `cargo clippy -p shellcanvas-core -p shellcanvas-filesystem-sdk --all-targets -- -D warnings` passes.
- Four filesystem SDK tests pass: path validation, bounded frames, exact large
  offsets and transport retirement on a mismatched reply.
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

1. Implement reviewed bridge installation/configuration, one-root/one-source
   grant management, helper supervision and explicit user access mode. Keep
   credentials in the desktop and never accept an executable path from a web app.
2. Add the Files folder/volume context action, attachment dialog and mapping
   status/management UI. Verify the modern neutral theme and compact layouts.
3. Pin connection generation and source identity throughout mapping lifetime.
   Closing a Files window must not stop a mapping; source replacement/disconnect
   and app quit must account for active mappings and busy handles. No silent
   forced detach or stale-handle reconnection.
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
   Windows cleanup-time deletion failures need visible reporting, file attributes
   and cross-handle directory rename need native checks, busy detach needs a
   control protocol, and memory-mapped workflows need explicit acceptance.
8. Review cancellation/late responses, bounded teardown and protocol errors with
   failure fixtures, then run the relevant core/desktop regression checks. Add
   reproducible release packages/notices and update bridge docs with exact verified
   platforms. Do not represent an unsigned preview binary as a supported release.

Preserve pre-existing theme changes in this worktree. The normal app profile and
the unrelated assistant repository were not modified by this implementation pass.
