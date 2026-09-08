# Native workspace service bindings

The native `WorkspaceServices` owner now binds every production file, text, mutation, move, transfer, terminal and host-settings service to an explicit `ConnectionResource`. The SSH connection flow constructs that owner through the same binding API used by the mixed-service tests. It does not bypass the wrappers.

## Routing and ownership

A workspace acquires one lease per selected connection resource. Repeating the same resource does not acquire a second lease; conflicting resources with the same instance ID are rejected. A service may bind only to a resource owned by that workspace, and an already-bound role cannot be silently replaced. These are trusted native construction rules, not a runtime extension sandbox.

File browsing, text, mutation, move and transfer roles must currently share one source. This prevents a browsing token from one connection being sent to another file endpoint. Console and settings can use independent sources. No paths are joined, translated or mapped between services. Different file namespaces on the same connection remain an adapter-construction responsibility; a future explicit namespace/mapping contract is needed before supporting those combinations.

Each operation checks its workspace lifetime and selected connection before dispatch and before returning a result. A disconnected file source cannot fall back to the console connection. Late reads are rejected. Writes that complete after their owner/source becomes unavailable report uncertainty and are not retried. Existing provider revisions, native session/terminal ownership and frontend app declarations remain additional checks.

Opened terminal and transfer handles retain the binding checks for subsequent I/O. Close/abort always remain callable for cleanup. A console or transfer handle returned after its owner closes is cleaned up with a bounded best-effort close/abort rather than adopted into another workspace. Adapter deadlines and transport closure still bound in-flight calls; immediate per-binding cancellation events are not implemented by this wrapper.

## Shared connections and teardown

Closing or dropping a workspace invalidates its retained service handles immediately and releases its connection leases. Releasing a lease while another workspace owns one leaves that connection usable. The final lease starts the connection resource's once-only teardown, even if stale service objects still hold references. Explicit resource disconnect can close a failed/selected connection regardless of leases. New leases cannot revive a closing connection.

Workspace disconnect releases all connections concurrently and collects failures, so one teardown error does not skip another connection. Canceled disconnect callers and dropped owners still release their leases. Workspace health is true while at least one selected connection remains connected; service dispatch checks its own source independently.

## Evidence and remaining work

Seven focused tests cover independent FTP-like files and serial-like console sources, failure of the file leg with continued console byte I/O, shared leases across workspaces, last-owner release, duplicate/foreign binding refusal, file-source isolation, delayed reads, uncertain writes, late console cleanup, transfer I/O refusal and abort after closure. They use fake adapters through real neutral service interfaces; they do not implement FTP or serial protocols.

All 53 Rust tests, all-target Clippy and the standard Windows debug build passed. The authorized evtinsait probe exercised the production owner with read-only SFTP, two independent terminals, resizing, surviving-console input, closed-workspace file refusal and teardown. It changed no remote files. The existing terminal layout was rechecked at 500px and 260px: unused row space matches the theme and stays above the footer; no further terminal source change was needed.

Production setup now also supports [installed native adapters](adapter-packages.md), with explicit file/console assignments and typed configuration. Those processes use this same workspace owner, and each selected source has its own connection identity. Whole-workspace reconnect preserves windows and acquires new handles. Native integration checks cover distinct file/console processes, unavailable capabilities and running connections surviving package updates/removal.

[Service availability](service-availability.md) supplies native snapshots, polling and partial UI. Independent-leg reconnect/rebinding, persistent composite profiles, mixing the built-in SSH connector with native packages, and general API/command routing remain before BASE-09/10 are complete.
