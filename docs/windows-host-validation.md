# Windows OpenSSH host validation

Validation date: 2026-09-13. Client: Windows desktop 0.1.5, plus local fixes on `codex/windows-host-validation`. Remote: Windows 11 Pro with Windows OpenSSH. This records one real host, not certification for every Windows configuration.

## Confirmed working

- Trusted SSH key authentication and Windows identification.
- SFTP home browsing, incremental directory pages and explicit cursor closure.
- SFTP root exposes three drive letters; direct OS discovery reports five volumes and three browsable drive locations.
- Remote clock reads returned the correct UTC offset and a timestamp within two minutes of the client. One attempt timed out; subsequent attempts passed.
- Interactive terminal open, resize, echo command input/output and close.
- New text files with spaces, apostrophes, Bulgarian text, emoji and CRLF; duplicate creation refused.
- Rename, move, spaced folders and refusal to delete nonempty folders.
- Mounted-filesystem **core contract**: exclusive create, random reads/writes, flush, truncate, close and removal. No native drive was attached for this test.
- Two simultaneous SSH sessions; disconnecting one left the other usable.
- Standard OpenSSH SFTP independently uploaded/downloaded a 2 MiB fixture with identical checksums.
- Every disposable remote fixture was removed after the runs, including failed cases.

## Fixed locally: Drives view always unavailable

`Bound<dyn FileSystemProvider>` forwarded browsing but omitted `volumes` and `set_volume_mounted`. The trait defaults therefore reported unsupported without calling the actual provider. Both methods now use the captured connection binding, with pre/post checks and uncertain-outcome handling for mutations. Regression tests cover forwarding, retired bindings and disconnect during a volume change.

Drive discovery also now reuses the same connection's already identified OS. Its fallback caches only positive detection, allowing Refresh to retry an inconclusive/failed probe. Tests cover both behaviors. These changes require a new desktop build; the user screenshots were from the preceding executable.

## Further fixes verified on the live host

1. **Windows editor overwrite.** Windows rejects restoring POSIX owner/group/permissions onto the temporary replacement file. Windows-identified services now require explicit confirmation for an in-place save, preserving the original file object. A second open while the writable handle exists also failed on this host, so Windows pre-save checks now read through that same read/write handle. Live checks passed for rejected unconfirmed saves, Unicode/CRLF overwrite, larger text across multiple write requests, stale revision rejection and empty saves. The file's Windows security descriptor, read with `Get-Acl`, was identical before and after. No metadata-preservation failure is ignored. In-place saves remain non-atomic and can leave partial contents if interrupted; the confirmation explains this.
2. **Binary upload compatibility.** Normal 32 KiB SFTP writes timed out repeatedly; 16 KiB requests succeeded. Uploads, text saves and mounted-file writes now split payloads into 16 KiB SFTP requests. Logical API chunk and file-size limits are unchanged, and failed writes are not automatically retried. The precise upstream transport/server interaction remains unproven; this is a measured compatibility fix. A final run with the normal API passed 2 MiB upload, remote copy, exact-byte download, stale-source rejection and canceled-upload cleanup.
3. **Windows path/handle metadata.** The same unchanged file reported mode `0600` via LSTAT and `0666` via FSTAT, with matching size, IDs and modification time. For Windows only, opening comparisons tolerate that mode difference. The complete path revision and the complete handle revision are independently rechecked at download completion. Exact regular-file type bits are required; links are not treated as regular files. Regression tests cover differing modes, changed size/time/owner/type, and later changes to either metadata source.
4. **Clock recovery.** One five-second clock read timed out, while repeated live samples passed. Windows clock reads now use the existing 15-second host-command budget to allow PowerShell startup. The UI retains a previous sample only within its existing two-minute freshness bound, retries a failed refresh after ten seconds, and never carries a sample across host changes. Simulated slow/stalled probes and freshness tests cover the behavior. Prolonged contention on a real host still needs observation; no claim is made that remote timeouts are impossible.

## Local regression checks

- `cargo test --workspace --locked`: 260 passed, zero failed, four ignored.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: passed.
- Frontend suite: 333 passed across 60 test files.
- Public repository content check and `git diff --check`: passed.
- Local optimized desktop build completed on D:, without installers or publication. Native UI and WinFSP acceptance remain with the user.

## Still needs desktop acceptance

### Native bridge 0.1.1 follow-up (2026-09-13)

The opt-in `src-tauri/examples/windows_bridge_probe.rs` uses the current desktop
SDK's protocol-2 server and the real Windows SFTP provider, with a fresh UUID
folder under the remote account's home and an unused local drive letter. The
optimized bridge passed native mount, a 108 KiB save-close-open byte round trip,
independent SFTP byte verification, held-file busy detach, ordinary detach and
confirmation that the local drive and remote fixture were removed.

The probe separately records **limitations**: opening a second reader while the
initial writable remote handle remains open failed; native rename also returned
an I/O error. Rejected rename preserved the exact source bytes and did not create
the destination. These are tracked in **WIN-HOST-04** and are not claimed as
passed because the local-provider native suite passes equivalent operations.

The bridge's independent native Windows suite passed against its optimized
0.1.1 executable, including I/O, mappings, injected errors, busy detach and pipe
loss. The privileged volume-flush subtest was explicitly omitted locally; release
CI runs it on the disposable runner. macOS native runtime testing remains pending.

After rebuilding: refresh the Drives view and browse each drive from its cards. Native clipboard round trips, folder transfers, WinFSP attachment/detachment, custom ACL behavior, junction/symlink handling and cross-drive moves were not validated by this probe. Windows mount-point assignment remains deliberately unavailable; no drive letters, partitions, ACLs or machine settings were changed.

## Repeatable probe

`crates/ssh-core/examples/windows_host_probe.rs` accepts host, user, private-key path and an additional known-hosts file. It requires `SHELLCANVAS_LIVE_WINDOWS_PROBE=1`, creates one UUID folder beneath the SFTP user's home, and cleans only descendants of that exact folder. It never prints credentials or existing file contents. A failing section remains a failure in the final exit status even when later independent checks pass.

The default upload uses the production `TRANSFER_CHUNK`; internal SFTP writes split it into compatible requests. `SHELLCANVAS_PROBE_WRITE_CHUNK=16384` retains the original smaller-API-write diagnostic, `SHELLCANVAS_PROBE_METADATA=1` prints metadata for the disposable file, and `SHELLCANVAS_PROBE_EDITOR_ONLY=1` stops after save checks. Allow roughly 4 MiB of temporary remote data. Run only against a host authorized for disposable writes. If interrupted, inspect the exact fixture path printed by the probe before cleanup.
