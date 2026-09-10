# Connection identity and established-resource lifecycle

`crates/service-contracts/src/connection.rs` defines `ConnectionIdentity` and `ConnectionLifecycle` without SSH, SFTP, Tauri or runtime dependencies. A lifecycle exposes a nonblocking local health snapshot and asynchronous disconnect. It does not require a hostname, port, shell or socket. Connection setup, credential interpretation and trust decisions remain adapter-owned.

The native workspace now owns a `ConnectionResource` instead of a concrete SSH connection. SSH implements the neutral lifecycle trait. `session_alive` and disconnect use that resource; file, terminal and settings roles retain their existing typed service handles. SSH negotiation is still the only production connect path.

Each established native connection gets an instance number distinct from its workspace/session ID and a generation. The current reconnect flow creates a new instance with generation 1; it never reuses an old instance. `Session.connections` exposes the established identities with the adapter ID and no credentials or endpoint data. Older/synthetic backends can omit this metadata; absence must not be interpreted as trust, availability or an implicit SSH source.

## Teardown ownership

The resource starts explicit disconnect once, immediately stops reporting connected, and stores its result for all callers. Canceling the caller that initiated disconnect does not cancel cleanup. An adapter error, task panic or 15-second outer timeout becomes a retained error with cleanup uncertainty where appropriate; no retry is automatic. SSH also retains its own shorter disconnect deadline.

The native registry still removes one workspace's terminal owners and closes its transfers before awaiting connection teardown. Removing the workspace prevents new operations from acquiring its service handles. Frontend stale-session and native operation ownership checks remain in place. This resource does not itself add per-service authorization or remap provider paths.

The subsequent [workspace binding layer](workspace-bindings.md) implements explicit native multi-source routing and last-workspace resource leases around this resource. One production SSH workspace still has one connection resource. Per-binding generations/status, independent leg reconnect and general command/API/configuration contracts remain separate work. Lifecycle tests alone do not prove a complete mixed-protocol desktop.

## Verification

Four native resource tests cover shared callers, canceled waiters, independent connections, cached teardown failures, fresh reconnect identity, adapter panic and bounded stalled teardown. Existing session-registry tests continue to cover terminal ownership and cleanup. The live `terminal_probe` now exercises the production connection resource around its two SSH consoles, verifies local health and distinct identity, and calls disconnect twice after terminal cleanup.

The 2026-09-08 validation passed all 46 Rust tests, 65 frontend tests, all-target Clippy and the standard Windows debug build. An authorized Linux-host probe passed two independent consoles, PTY resize, surviving-console I/O after one closes, stale/cross-session refusal, neutral lifecycle health and repeated disconnect. It changed no remote files.

No visual change or new protocol support is claimed by this slice.
