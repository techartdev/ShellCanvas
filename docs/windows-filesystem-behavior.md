# Windows filesystem behavior

Status: accepted release limitations for ShellCanvas 0.1.6 and Drive Bridge 0.1.2, 2026-09-13.
Windows behavior is the baseline for a Windows client. A Linux operation being
possible does not imply that Windows must permit it. Do not recommend replacing
an SSH server or display a blanket server warning without identifying the actual
operation and testing the alternative.

## Observed comparison

The same Rust Windows API operations were run against a disposable local Windows
directory and a WinFsp attachment backed by a Windows OpenSSH host through the
current SFTP provider. This is a local Windows baseline versus a remote Windows
attachment, not a direct native test running on the remote host. No remote helper
or server configuration change was used.

| Operation                                           | Local Windows baseline                    | Windows SFTP attachment after fixes         |
| --------------------------------------------------- | ----------------------------------------- | ------------------------------------------- |
| Rename a closed file to an unused name              | Allowed; bytes preserved                  | Allowed; bytes preserved                    |
| Delete a closed file                                | Allowed                                   | Allowed                                     |
| Read while a read/write handle permits all sharing  | Allowed                                   | Refused with error 1117                     |
| Rename while a reader permits delete sharing        | Allowed; reader retains original bytes    | Refused with error 1117                     |
| Rename while a reader denies delete sharing         | Refused with error 32; original preserved | Refused with error 32; original preserved   |
| Read while another handle requests exclusive access | Refused with error 32; original preserved | Refused with error 1117; original preserved |

The last two rows test **correct refusal**, not missing functionality. SFTP v3
can lose the underlying Windows error and return a generic failure. Do not
translate every generic I/O failure into a sharing violation: it can have other
causes. The comparison prints the error codes separately from refusal and byte
preservation checks.

Windows uses the sharing mode selected when each handle opens. In particular,
`FILE_SHARE_DELETE` permits subsequent delete/rename access; omitting it can
block rename until the handle closes. See Microsoft's
[CreateFile sharing rules](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
and [rename explanation](https://devblogs.microsoft.com/oldnewthing/20211022-00/?p=105822).

The inspected Windows OpenSSH implementation opens read/write SFTP handles
exclusively and does not grant delete sharing to data handles. This explains the
two extra restrictions observed here, but is not a claim about every Windows
SSH server or version. See its
[Windows file-open implementation](https://github.com/PowerShell/openssh-portable/blob/latestw_all/contrib/win32/win32compat/fileio.c).
The current SDK/SFTP path does not transmit the client's individual Windows
sharing flags, so changing a server alone does not guarantee complete parity.

## Implementation changes

- Drive Bridge no longer opens a remote data-read handle for an existing file
  requested only for read-only metadata or namespace operations such as rename.
  That extra handle could block the bridge's own rename. These contexts resolve
  metadata by path and follow renames performed through the bridge. Actual data
  access and writable metadata retain provider handles, preserving the opened
  object's identity for writes. Read-only metadata contexts do not pin an object
  against an external replacement at the same path.
- When replacement is requested but the destination does not exist, a server
  without the atomic-replace extension can use ordinary SFTP RENAME. Existing
  destinations are still refused. The client never deletes the destination to
  emulate replacement and does not retry a rejected mutation. Concurrent
  destination creation is left to the server's no-overwrite RENAME contract;
  this is not a stronger guarantee than that server implements.
- The live probe prints every comparison row. Ordinary I/O, closed-file rename/delete, legitimate sharing refusals, safety assertions and cleanup must pass. The two sharing gaps above are accepted for release and remain visible in output. Set `SHELLCANVAS_REQUIRE_WINDOWS_PARITY=1` to make those gaps fail the probe when assessing a future upstream change.

## Validation and boundaries

Core protocol tests cover an absent destination, an existing destination,
concurrent destination creation rejected by the server, and an explicitly
non-replacing request. They reject unexpected mutation packets, including any
attempt to delete the destination.

The separate Drive Bridge native integration test covers metadata/rename without
provider data-read permission, ordinary I/O, replacement save, read-only
attributes, timestamps, native copy, mapped-file I/O, open-descendant directory
rename refusal, error preservation, detach, and transport loss. Its privileged
volume-flush subtest is explicitly omitted for the ordinary desktop account;
per-file flush and the unit-level volume-flush checks still run.

Run the local sharing baseline with:

```powershell
cargo test -p shellcanvas --example windows_bridge_probe native_windows_sharing_baseline -- --nocapture
```

The opt-in live `windows_bridge_probe` uses a verified SSH connection, a newly
created disposable folder, and an unused local drive letter. Its arguments are
`HOST USER KEY TRUST_FILE BRIDGE_EXE`, with `SHELLCANVAS_LIVE_WINDOWS_PROBE=1`.
It verifies transferred bytes independently over SFTP and removes its mapping
and fixture even when the comparison reports remaining gaps.

This targeted comparison is not certification for every Windows application,
filesystem, network share, ACL operation, byte-range lock, or concurrent external
change. Staged editor saves that preserve Windows security descriptors remain a
separate issue; the existing non-atomic-save confirmation remains applicable.
