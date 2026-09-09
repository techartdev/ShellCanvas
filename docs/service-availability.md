# Workspace service availability

The desktop now consumes a capability snapshot independently of whole-workspace health. Each entry identifies the capability, availability state, optional reason and the exact connection instance/generation/adapter that supplies it. The native SSH setup returns the initial snapshot, and the existing four-second health poll now refreshes it through `session_status`. Older and synthetic backends may continue to provide only `alive` and the original capability array.

Native snapshots currently report **available**, **unsupported** or **disconnected**. A service must be both bound and advertised by discovery before it is available; an interface object alone must not invent support for an operation such as atomic text replacement. The snapshot checks the selected connection's health. Available means the adapter supplies the operation through a live connection, not that every path is writable or every requested console can open. Providers still validate individual operations. File permission errors do not disable an entire filesystem.

The frontend contract and UI also understand **checking** and **denied**, including provider-supplied reasons. Native per-service probes, denial classification and push events are still pending; the client does not infer these states from arbitrary error strings.

## Desktop behavior

- Losing file access disables remote actions and new file/editor windows while keeping existing cached listings and drafts accessible. An independent console continues to receive input/output with the same shell handle.
- Losing console access disables terminal input and new shells while independent file browsing continues. The status bar reports that some services are unavailable.
- Host details lists each capability with its source, status and reason. Launcher/dock/window controls use required capabilities; unsupported optional write operations do not prevent read-only browsing.
- Status updates preserve the workspace, app instances and bound service object. Per-capability epochs reject late results even after availability returns, without invalidating unrelated services. Late writes report uncertainty; affected transfer tickets are canceled, and late download confirmation asks the user to inspect the local destination.
- Polls for closed/replaced sessions cannot revive them. Whole-workspace loss still uses the existing disconnect and explicit reconnect flow.

Connection-specific labels now use the reported terminal adapter. The desktop claims SSH workspace/verified SSH host only for explicitly identified SSH connections, rather than applying those labels to mixed-service fixtures.

## Verification

At the initial partial-availability checkpoint, 70 frontend tests, 54 Rust tests,
all-target Clippy and the standard Windows debug build passed. Focused tests cover
source attribution, discovery-limited support, partial connection loss, stale reads
after recovery, uncertain writes, transfer cleanup, late polls and independent console I/O.

The browser fixture at `tests/fixtures/service-status.html` uses the actual desktop components and status poll with fake FTP-like file and serial-like console services. The walkthrough verified cached Files with disabled actions after file loss, continued terminal input with one shell opening, source/status rows in Host details, restored read-only file access, disabled console controls after console loss, and successful navigation to Documents through the surviving file service. It implements no new network protocol and changes no remote host.

Production setup now supports [composed workspaces](workspace-bindings.md) with
built-in SSH and installed adapters, independent source replacement, explicit
service identities and custom-API-only workspaces. The adapter desktop fixture
covers generated custom-service-only installation and calls; the
[connection UI fixture](connection-ui-validation.md) covers native polling after
partial file loss while preserving the console. Status is polled; push-based
health reporting is not required by the current adapter contract. See the
[kernel roadmap](kernel-roadmap.md) for remaining validation and platform work.
