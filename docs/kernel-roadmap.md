# ShellCanvas system API and runtime extensions

Objective: provide a small, coherent virtual-desktop API for bundled and community apps, with reusable system UI and runtime-loadable apps, device providers and connection adapters. Adding an extension must not require rebuilding the desktop. This document tracks the full objective, not just the first implementation slice.

## Delivery and evidence gates

| Area                       | Required behavior                                                                                                                                      | Completion evidence                                                                                                    | Status      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------- |
| System UI                  | Promise-based message boxes, Open and Save pickers, consistent keyboard/focus behavior, per-window cancellation and session isolation                  | Bundled app adoption, lifecycle tests, desktop/tablet walkthrough                                                      | In progress |
| App system services        | Versioned API for app/window lifecycle, settings/storage, clipboard, events and service discovery; structured errors and cancellation                  | Independent sample app using only the public SDK; contract tests                                                       | In progress |
| Runtime apps               | Install, validate, activate, update, disable and remove packages while the desktop runs; preserve unsaved work and reject stale calls                  | Load a separately built app without rebuilding/restarting core; update and unload walkthrough                          | In progress |
| Extension boundary         | Package identity, declared access, isolated external UI, enforced broker, revocation and resource cleanup                                              | Negative fixtures for direct IPC, undeclared calls, foreign handles, late replies and teardown                         | In progress |
| Runtime adapters/providers | Versioned transport-neutral contract and lifecycle; only supported services advertised; arbitrary protocol implementations supplied as packages        | Independently built adapter loaded at runtime, files/console/custom-service fixtures, failed leg and replacement tests | Pending     |
| Composition and hot switch | Independent service bindings and generations, explicit replacement, live instances pinned or safely retired, no silent rerouting of pending operations | Mixed-service workspace and partial reconnect/hot-switch walkthrough                                                   | Pending     |
| Developer experience       | Public SDK, package schema, starter generators, runnable examples, error reference, compatibility/lifecycle documentation                              | Clean-checkout starter build and package installation with no core edits                                               | Pending     |
| AI development skills      | Repository-distributed skills for apps, extension packages and protocol/device adapters; deterministic commands and verification guidance              | Follow each skill to generate/build/test/load its example                                                              | Pending     |

## Direction

- Apps consume workspace services, not SSH sessions or OS-specific path syntax. Existing file/terminal/settings contracts remain useful; custom namespaced services must be possible without adding every vendor operation to the kernel.
- Keep trusted bundled React modules working while the external package API is introduced. External code must not gain the bundled webview's unrestricted native privileges.
- UI packages and native connection adapters have different execution/trust requirements. Avoid an unstable native dynamic-library ABI. A versioned process/service protocol is the candidate for adapters that need arbitrary networking, serial devices or platform libraries; the process trust model must be explicit.
- Runtime update is a generation change. Existing work must either retain its original generation or finish/cancel before replacement. An old reply cannot act on a new host or new package generation.
- System file pickers return provider-owned locations. Selecting a destination does not write bytes or grant permission to overwrite; a save workflow performs validation and conflict handling through the service contract.
- Keep source code, installed packages, private credentials, app data and temporary transfer metadata separate. SDK examples must work without real credentials.

This remains an active implementation plan. A passing unit suite alone does not establish runtime installation, cross-platform isolation, real protocol support or completion of the goal.

## Runtime boundary checkpoint

The [runtime app system](runtime-apps.md) now integrates persistent installation and reviewed grants into the actual desktop's Apps manager, launcher and dock. Running windows pin their package and permission generation. Update/disable preserve drafts; removal requires closing the running windows. App-reported document state participates in normal close, workspace-close and native-quit reviews.

The Windows native boundary has an executable WebView2 probe and an owner-bound custom-resource loader. It exposed Wry's subframe initialization behavior; the native IPC transport is now guarded before its invocation-key closure is initialized. Native canary checks verify denied direct IPC while the approved broker works. The desktop CSP permits the managed app-resource origin. Other native platforms remain gated pending equivalent evidence; resource containment and publisher authentication are not claimed.

A separate desktop integration probe renders the real desktop with a separately bundled sample and fake host services. It checks two installed versions, draft and grant isolation, shared dialogs, disable/removal, dirty-close protection and explicit reconnect rebinding. Native runs additionally exercise quit protection. A browser walkthrough verifies overlapping iframe-body focus. These fixtures do not connect to a real host or automate the operating system's package chooser. See [the probe instructions](runtime-apps.md#native-desktop-integration-probe).

Remaining runtime-app work includes cross-process catalog invalidation and running-window coordination. The app services, transport-neutral adapter runtime, composite service generations, standalone SDK/schema/starters and AI skills remain required. Local checks and the Windows integration do not complete those gates.

App-owned [local data and settings](app-storage.md) now have an explicit permission, paginated keys, revision-checked writes/deletes and cancellation. Data persists independently of packages and sessions. The SDK and Field Notes example use the brokered API.

The desktop now supplies [environment snapshots, service discovery and state events](app-events.md). Discovery uses the registered method map and keeps permissions separate from availability. Window-owned event journals provide bounded replay with explicit reset; SDK listeners share one cancelable stream. Reconnect approval and visibility changes are covered by the native integration fixture. Clipboard, further window lifecycle actions and the runtime provider/adapter route are still required.
