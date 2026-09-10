# Drives and mounts

Files has a **Drives** entry beside Home and Filesystem. It opens a refreshable
inventory of volumes and mounted locations. Select a location to browse through
the existing file service. System mounts are hidden by default and can be shown.
Discovery failure does not prevent ordinary browsing or entering a known path.

SSH can carry both SFTP and native OS commands; SFTP itself does not provide disk
discovery or mounting. All storage operations belong to the **Files source**.
A console supplied by another connection is never used for this purpose.
Permissions, SFTP restrictions/chroots, host tools and the account's mount
namespace still apply. An advertised location may therefore refuse browsing.

## Implemented providers

| Device | Discovery and browsing | Mount controls |
| --- | --- | --- |
| Linux, including Raspberry Pi OS | `/proc/self/mountinfo` includes block, network and bind mounts; `lsblk` adds filesystem-bearing unmounted block devices | UDisks `udisksctl`, if installed; existing account authorization only |
| macOS | `diskutil` plist inventory, including APFS volumes; `mount` adds network locations | `diskutil mount` / `unmount` for eligible volumes |
| Windows | PowerShell `Get-Volume` / `Get-Partition` access paths, plus logical drives visible to the SSH account | New access-path assignment remains a follow-up |
| Other devices or restricted SFTP | Existing Home, roots and manual paths continue to work | Optional adapter implementation |

macOS and Windows are explicitly identified by the device detector. Unknown
devices retain generic identity and only their actual connection capabilities.
Recognizing an OS does not imply that Linux settings commands work on it.

Mount/unmount is an explicit reviewed action, never an automatic consequence of
browsing. The provider refreshes the inventory and checks its revision, target
identity and offered action before running a fixed native command. It reads back
mount state after success. A failed or timed-out operation may have completed;
refresh before retrying. There is no automatic installation, elevation, force
unmount, formatting, partitioning, encrypted-volume unlock or persistent fstab
editing. Protected system locations have no mount controls. Linux volumes with
multiple mount locations remain browse-only to avoid ambiguous unmount behavior.

## Optional adapter contract

Existing `FileSystemProvider` implementations require no changes. The default
`volumes()` returns an unavailable notice; `set_volume_mounted()` rejects writes.
Native adapters may advertise these optional methods in their `files` v1 service:

| Method | Parameters | Result |
| --- | --- | --- |
| `files.volumes` | `{}` | `FileVolumes` |
| `files.setVolumeMounted` | `{id, revision, mounted: boolean}` | `null` after confirmed success |

`FileVolumes` is `{revision, volumes, notices}`. Each volume is
`{id, name, detail, locations: [{path, name}], system, canMount, canUnmount}`.
IDs, revisions and paths are opaque provider values. The revision must change
when the reviewed inventory changes. `locations` is empty for a volume with no
mounted browse location. `system` marks protected system volumes/mounts.
No action may be offered for system volumes. Only an unmounted volume can offer
mount; only a mounted volume can offer unmount. A provider may always offer
neither. Disk enumeration is not a prerequisite for file access.

The host validates unique nonempty IDs, nonempty locations, revision and
advertised methods, and binds calls to the accepted Files connection. The
adapter must also revalidate the exact target and permissions at mutation time,
serialize conflicting changes, and confirm the resulting state. Never execute
a caller-provided ID as shell code. Errors must state uncertain outcomes instead
of claiming a rollback. No retry of a mutation is automatic.

This addition is for built-in Files and native connection adapters. The isolated
public app SDK has not gained disk-management permissions or commands.

## Validation and remaining scope

Read-only live probes identified the Catalina Mac as macOS 10.15.8, discovered
eight inventory entries, and opened its root via SFTP. The Linux VPS returned 23
entries and five browsable non-system/root locations. UDisks is absent on that
VPS, so it correctly offers no controls. No live disks were mounted/unmounted.
The reusable probe is `cargo run -p shellcanvas-core --example volumes -- ...`.

Both Windows query scripts were exercised read-only on the development PC. The
logical-drive fallback returned C:, D:, E:, F: and Z: in under a second; the
detailed query also returned volumes without access paths but was slow. The SSH
provider bounds that query with its existing command timeout and then falls back.

Parser, target/revision validation, optional adapter negotiation and source
lifetime tests cover the new contract. A synthetic UI fixture exercises mount
confirmation, cancellation, refresh, browsing, discovery errors and compact
layouts. Physical removable-disk mount/unmount acceptance, Windows-over-SSH
acceptance and Windows access-path assignment remain separate follow-ups.
