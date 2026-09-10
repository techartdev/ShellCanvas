# Connection recovery

Connection loss leaves the workspace open. Terminal input and remote file actions stop; terminal output, cached file listings, window layout and editor drafts remain available. File listings are labeled as cached. Copying local text and paths still works.

**Disconnect** now does the same deliberately: it releases the host connection and keeps the workspace open. It does not discard drafts or require a discard confirmation. During teardown, the button reads Disconnecting and reconnect/close controls wait for cleanup to finish. Concurrent teardown requests for the same session share one pending operation. Cleanup errors leave the workspace disconnected and report that cleanup is unconfirmed.

**Close workspace** removes its windows. It is available from the desktop menu, or from the bottom button after disconnecting. Dirty drafts and proposed settings require a separate Discard and close confirmation; Keep working preserves them. A closed workspace is distinct from a disconnected workspace that can be reconnected. Both actions wait for app operations marked busy.

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

## Deliberate disconnect verification (2026-09-08)

- Browser walkthrough: a dirty existing-file editor survived delayed Disconnect; reconnect and close controls were disabled while teardown was pending. Close workspace prompted separately, and Keep working preserved the draft. Reconnect opened a fresh shell in the existing windows and subsequent Save succeeded. Simulated teardown failure retained a second draft and reported failure.
- Fresh-page browser check: disconnected new-window/launcher actions were disabled, existing Files and Terminal windows remained accessible, cached listing/output stayed visible, and terminal refitting did not replace the disconnected reason with a resize error. Terminal callbacks now check current connection state, suppress stale errors and close late-opened handles.
- Two active browser workspaces remained isolated: deliberately disconnecting session 103 left session 104's original shell accepting further input, with no new shell opening in the survivor.
- The workspace-state regression now verifies disconnected capabilities in addition to retained desktop/draft state. All 70 frontend tests and the standard Windows debug build passed; no Rust code changed in this slice.
- The Windows native app connected to an authorized Linux test host, opened an empty editor and completed Disconnect with all three windows retained and remote actions disabled. The app then exited normally. No remote files were changed. Native text entry was not verified: accessibility reported only the root document as focused, and `set_value` failed with `Requested property was not in the CacheRequest (0x80070057)`. Native dirty-draft reconnect remains a follow-up; browser evidence does not substitute for it.

This separates current whole-workspace recovery from future independent-connection reconnect. Service-specific replacement, configuration and generation contracts remain in BASE-09.
