# Connection recovery

Connection loss leaves the workspace open. Terminal input and remote file actions stop; terminal output, cached file listings, window layout and editor drafts remain available. File listings are labeled as cached. Copying local text and paths still works.

**Reconnect host** opens the connection dialog for that workspace. Host, port and username stay fixed so an existing draft cannot silently move to a different endpoint. Authentication can be supplied again; passwords and key passphrases are not retained in the workspace snapshot. Use Add host for a different endpoint.

A successful reconnect creates a new backend session and service binding while retaining the workspace and app instances. Files refreshes its current folder. Editor buffers and their original revisions survive, so saving still checks for remote changes. Each Terminal opens a fresh shell; this does not resume a remote process or preserve the old terminal buffer across successful reconnection. Other host workspaces keep their sessions and shells.

If a replacement session lacks a capability, existing apps retain their local work and explain the limitation. Their remote actions and new-instance controls are disabled. Existing minimized windows remain accessible from the dock and launcher, including editor drafts.

## Cancellation

The connection dialog offers Cancel connection while connecting. Escape or closing the dialog also cancels. Native attempts have independent IDs and cancellation signals, including cancellation before the connect command starts. A canceled result cannot replace a newer connection or reopen the dialog. If a connector completes after cancellation, its returned session is disconnected.

## Validation and boundaries

- Browser fixtures verified draft retention and successful subsequent save, folder retention, a second host retaining its shell, and capability loss without discarding a draft. They also verified canceling a slow attempt and cleanup of a late result after a newer host connected.
- Workspace tests cover endpoint checks, unchanged app-instance state, rejected stale callbacks and exclusion of credentials from reconnect snapshots.
- Native tests cover attempt isolation and cancellation before/during work. A local TCP fixture holds an SSH handshake open and verifies socket closure after cancellation.
- Windows debug build, 29 frontend tests, 14 Rust tests and Clippy passed for this slice.
- Health reporting still depends on SSH closure/keepalives and can take roughly a minute for a silently unreachable peer. There is no automatic retry or credential vault. Cancellation during every authentication/provider phase and physical-network interruption still need native walkthroughs.
- Drafts and layout remain in memory. A crash or forced quit can lose them. Interrupted remote writes can have uncertain outcomes; verify the destination before retrying.
