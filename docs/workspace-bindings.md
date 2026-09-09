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

### Prepared source replacement

The native owner now gives each selected connection its own workspace-local lifetime. `replace_source(expectedIdentity, preparedWorkspace)` commits a prepared, single-source replacement synchronously. The expected identity must still match; the replacement must be connected, use a fresh identity or higher generation, and preserve exactly the selected service families. Retired generations remain recorded so switching A → B → A cannot revive an old approval. It cannot take over an unrelated source or collide with its custom methods. Validation failure drops the candidate and leaves current bindings untouched.

File, console, settings and custom-service selections are tracked independently of actual support. A selected Files source may provide no file capabilities now and gain them after replacement. Its identity still appears on unsupported status entries. Replacing Files can lose editing/transfer capabilities without retaining old implementations. Discovery restrictions on other sources remain unchanged.

Commit retires the replaced source's old handles immediately, including retained console/transfer/custom handles, while preserving the other sources' handle identities. In-flight reads cannot return stale results; dispatched writes/custom calls report an uncertain outcome after retirement. The prepared services retain their own lifetime after ownership moves into the live workspace. Another workspace sharing the retired connection keeps its independent lease and handles.

The transaction returns the old connection lease. Close it outside the registry lock; teardown failure is a post-commit cleanup failure, not permission to retry or roll back the replacement. Dropping that lease still triggers final-owner cleanup.

The desktop exposes this transaction through [installed-adapter source replacement](adapter-packages.md#replace-one-connection). Native file, settings and console-open requests carry the identity captured when the frontend service binding was created. Validation and service selection occur under the same registry lock. Availability polling cannot repin an existing handle. Legacy requests without an identity remain accepted only while their service family has never been replaced; they cannot follow a replacement.

Transfer preparation revalidates the original source after native pickers and before registering tickets. Each ticket retains its selected provider; starting it never resolves a new provider from the workspace. Directory scans and delayed Explorer streams use that same retained service. Existing stream/ticket identities continue to authorize cleanup after source retirement. Backend decorators must wrap `bindSources` results too, so instrumentation does not disappear when handles are captured.

The desktop assigns service handles per window using the app's declared standard and custom services. A source identity change gives affected apps a new handle; unrelated apps retain theirs. Availability changes update the existing handle without repinning it. Native status includes selected custom-service sources even when a service is temporarily unavailable. Binding plans have no activation/retirement effects until React commits them.

Files resets navigation, selections and pending actions to the replacement provider's default root. Editor preserves its draft and undo history, clears the old address and disables Save/Reload for the detached document. Open and Save As start at the new provider's default rather than carrying the old provider's locations into it. Successful Save As attaches the draft to the resulting document. File clipboard ownership survives changes to unrelated sources and remains shared with newly opened Files windows; changing the file source retires that clipboard state. Terminal does not restart because its parent supplies a different error callback.

The production `replace_adapter_source` command prepares one source, acquires registry/transfer locks cancelably, then commits synchronously against the expected identity. Retired-file transfer jobs are canceled before new preparations can register. Closing the retired lease happens after releasing the locks. Success is returned even if cancellation arrives after commit; cleanup errors are warnings rather than rollback. The frontend updates the existing workspace and source's in-memory profile without replacing its window collection. Source revisions reject stale polls and custom discovery returns only bindings from the caller's accepted source map. The Windows adapter fixture exercises both independent Files replacement and explicit custom-app acceptance.

### Desktop source-switch probe

`tests/fixtures/source-switch-probe.html` renders the real Files, Terminal, Editor and shared dialogs with two synthetic file sources and an independent echo console. The source changes without changing the logical workspace ID. It checks retained editor/terminal elements, console input, draft/undo retention, disabled old Save/Reload, and Save As through the new provider. The fixture rejects any old provider location sent to the replacement. It isolates UI rebinding; the native replacement command is covered by the adapter fixture. It does not exercise a real device protocol or the user's clipboard.

```powershell
npm run tauri -- build --debug --no-bundle --config src-tauri/tauri.source-switch-probe.conf.json
node scripts/run-extension-probe.mjs
```

The runner records `.local/native-extension-probe/result.json`. Restore the normal desktop executable after running the probe with `npm run verify -- --native`. The same fixture runs through the development server for browser inspection. Unit tests in `src/workspace-bindings.test.ts` additionally cover independent custom sources, clipboard ownership across window creation/closure, abandoned plans and late results.

The ownership regression suite covers independent FTP-like files and serial-like console sources, failure of the file leg with continued console byte I/O, shared leases across workspaces, last-owner release, duplicate/foreign binding refusal, file-source isolation, delayed reads, uncertain writes, late console cleanup, transfer I/O refusal and abort after closure. Replacement cases additionally cover a surviving open console, abandoned/rejected/competing proposals, retired-generation reuse, capability loss/recovery, post-commit cleanup failure and preserved custom bindings. They use fake adapters through real neutral service interfaces; they do not implement FTP or serial protocols.

At the workspace-owner checkpoint, 53 Rust tests, all-target Clippy and the standard Windows debug build passed. The authorized evtinsait probe exercised the production owner with read-only SFTP, two independent terminals, resizing, surviving-console input, closed-workspace file refusal and teardown. It changed no remote files. The existing terminal layout was rechecked at 500px and 260px: unused row space matches the theme and stays above the footer; no further terminal source change was needed.

Production setup now also supports [installed native adapters](adapter-packages.md), with explicit file/console assignments and typed configuration. Those processes use this same workspace owner, and each selected source has its own connection identity. Whole-workspace reconnect preserves windows and acquires new handles. Native integration checks cover distinct file/console processes, unavailable capabilities and running connections surviving package updates/removal.

[Service availability](service-availability.md) supplies native snapshots, polling
and partial UI. [Persistent composite profiles](workspace-profiles.md), built-in
SSH alongside native packages, and the standard adapter service bridges are now
implemented. Current validation requirements and separate platform milestones
are tracked in the [kernel roadmap](kernel-roadmap.md); the historical test counts
above are not current completion totals.
