# File permission validation

`crates/ssh-core/examples/permission_probe.rs` tests the real SFTP adapter under an unprivileged remote identity. It requires the authorized root SSH login for fixture setup, an existing `nobody` account, `/usr/sbin/runuser` and `/usr/lib/openssh/sftp-server`. It creates no users and installs nothing. Missing prerequisites fail before fixture creation.

The probe creates one `/tmp/shellcanvas-permissions-UUID` directory. Root-owned readable and private files exercise refusals; a separate subdirectory is owned by the existing unprivileged account for allowed operations. Only this new directory's ownership and modes change. Independent SSH exec channels run the existing SFTP server as `nobody`; production connection setup is unchanged.

The authorized evtinsait run on 2026-09-08 verified:

- Directory listing and public preview remain usable, while private preview, editor reads and downloads return the SFTP PermissionDenied status.
- Folder creation, text creation, editor save, rename, delete and upload fail with actual permission-denied responses in the root-owned parent. Original contents remain unchanged and no temporary files remain.
- The same unprivileged services then create/edit a permitted text file, upload/download a 32 KiB + 7 byte binary file, rename and remove entries in their own directory. Bytes roundtrip exactly and cleanup leaves that directory empty.
- Known fixture files and the empty directories are removed, followed by SSH disconnect. Cleanup never recurses into unexpected contents; an unexpected leftover causes an error naming the disposable directory for inspection.
- The move extension rejects moving out of the protected parent and into it with actual PermissionDenied responses, preserving source content. The same unprivileged service then moves an owned file into a writable child folder and back, and removes the empty folder. Exact cleanup covers both possible file locations.

The workspace UI fixture now offers **Deny next file change**. Browser checks verified that a denied folder creation retains its entered name and permits a later retry. A denied editor save retains the exact draft, keeps the unsaved marker and re-enables Save; a subsequent allowed save clears the error and dirty state. Neither failure disconnects the workspace.

Clippy's all-targets check includes the probe. These results close the unprivileged SFTP permission/refusal gate. They do not establish physical-network interruption outcomes, remote administrative authorization, other SFTP server implementations or every Windows GUI transfer error path.
