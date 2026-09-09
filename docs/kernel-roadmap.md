# ShellCanvas system API and runtime extensions

Objective: provide a small, coherent virtual-desktop API for bundled and community apps, with reusable system UI and runtime-loadable apps, device providers and connection adapters. Adding an extension must not require rebuilding the desktop. This document tracks the full objective, not just the first implementation slice.

## Delivery and evidence gates

| Area                       | Required behavior                                                                                                                                      | Completion evidence                                                                                                    | Status      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------- |
| System UI                  | Promise-based message boxes, Open and Save pickers, consistent keyboard/focus behavior, per-window cancellation and session isolation                  | Bundled app adoption, lifecycle tests, desktop/tablet walkthrough                                                      | In progress |
| App system services        | Versioned API for app/window lifecycle, settings/storage, clipboard, events and service discovery; structured errors and cancellation                  | Independent sample app using only the public SDK; contract tests                                                       | In progress |
| Runtime apps               | Install, validate, activate, update, disable and remove packages while the desktop runs; preserve unsaved work and reject stale calls                  | Load a separately built app without rebuilding/restarting core; update and unload walkthrough                          | In progress |
| Extension boundary         | Package identity, declared access, isolated external UI, enforced broker, revocation and resource cleanup                                              | Negative fixtures for direct IPC, undeclared calls, foreign handles, late replies and teardown                         | In progress |
| Runtime adapters/providers | Versioned transport-neutral contract and lifecycle; only supported services advertised; arbitrary protocol implementations supplied as packages        | Independently built adapter loaded at runtime, files/console/custom-service fixtures, failed leg and replacement tests | In progress |
| Composition and hot switch | Independent service bindings and generations, explicit replacement, live instances pinned or safely retired, no silent rerouting of pending operations | Mixed-service workspace and partial reconnect/hot-switch walkthrough                                                   | In progress |
| Developer experience       | Public SDK, package schema, starter generators, runnable examples, error reference, compatibility/lifecycle documentation                              | Clean-checkout starter build and package installation with no core edits                                               | In progress |
| AI development skills      | Repository-distributed skills for apps, extension packages and protocol/device adapters; deterministic commands and verification guidance              | Follow each skill to generate/build/test/load its example                                                              | Implemented |

## Direction

Windows adapter tree checkpoint (2026-09-09): adapters start suspended, join a
private job object and resume only after assignment. Cleanup stops descendants,
waits for process exits and retains installed assets if cleanup is unconfirmed.
Three real-process tests cover close/drop, crash/protocol failure, canceled/rejected
startup and termination of the owning supervisor, with independent adapters left
running. Non-Windows tree supervision, diagnostics, crash staging cleanup and the
other delivery gates remain required. See [adapter lifecycle](adapter-process.md).

Catalog coordination checkpoint (2026-09-09): desktop instances now refresh app
catalog changes through invalidation plus focus/periodic recovery. Asynchronous
launch checks current storage under a shared app lease; removal requires an
exclusive lease across all generations. Running windows retain their original
code/grants. Eleven real two-process Windows checks pass, including removal after
terminating the fixture peer. Native macOS/Linux evidence, public Cut/custom
clipboard formats, adapter lifecycle hardening and other delivery gates remain.
See [runtime coordination](runtime-apps.md#multiple-desktop-instances).

Shared file clipboard checkpoint (2026-09-09): installed apps and bundled Files
can paste each other's remote Copy selections within the original workspace and
file-service instance. Paste captures the clipboard version, uses copy permission
for remote selections and upload permission for local files, and creates a fresh
disk catalog per paste. Source replacement and changed clipboard contents reject
the operation. All 80 Windows installed-app checks pass, including app-to-app,
app-to-Files and Files-to-app paths; native tests verify original-provider ownership
and independent repeated pastes. These tests use synthetic clipboard services.
Public Cut/move, custom formats, cross-process clipboard exchange, interruptible
native preparation and remaining lifecycle/platform gates are still open. Earlier
checkpoint paragraphs below describe their scope at that time.

File export checkpoint (2026-09-09): installed apps can publish remote references
through `client.clipboard.copyFiles`, with separate file-export/download grants,
ordered metadata chunks, original-binding checks and mandatory publication busy
guards. Native registration reports progress early so a racing cancellation can
reach its owner. Session cleanup no longer requires unrelated browsing permission
or a live binding. Seven broker/SDK tests, an ownership regression and the
77-check Windows installed-app fixture pass with synthetic clipboard services.
Shared remote selections between installed apps and bundled Files, public Cut,
custom formats and remaining lifecycle/platform gates remain open. Current export
targets Windows Explorer; it does not complete unified in-desktop file clipboard.

File paste checkpoint (2026-09-09): installed apps can prepare native file-list
uploads using `client.clipboard.pasteFiles`, with separate clipboard-read and
upload grants and the existing owned transfer lifecycle. Clipboard selections now
share one disk catalog and one queued job; the old 16-root clipboard limit is
removed. Files open on demand with metadata checks, and per-item completion
updates allow cancellation between items. The Windows installed-app fixture passes
73 checks with synthetic clipboard services. Large-selection, permission and late
cancellation tests pass. Outgoing app file copy/cut, custom formats, interruptible
native root preparation and remaining lifecycle/platform gates are still open.
The separate Upload/Download picker limits have not changed.

Image clipboard checkpoint (2026-09-09): the SDK now reads/writes RGBA images with
separate image grants, window-owned chunk streams, captured pixels and complete
publication. Six protocol tests and two native-wrapper cleanup tests pass; the
independently built app passes 71 Windows desktop checks, including native image
resources and denied image reads. This uses an injected clipboard, not the user's
OS clipboard. File/custom-format APIs and live OS image interoperability remain.
The window API's compact and inactive-workspace walkthroughs now pass at 800×900
and 1360×900. Physical tablet/mobile validation remains a different gate.

Window API checkpoint (2026-09-09): installed apps can read window state, focus,
minimize, maximize, restore and request guarded close through the public SDK.
Host-owned callbacks accept no target identity; transfers/settings retain their
mandatory busy guards. The independent SDK build and 64-check Windows installed-app
fixture pass, including eight window checks. Compact-layout and inactive-workspace
control walkthroughs remain follow-ups. File/image/custom clipboard APIs, catalog
coordination, adapter lifecycle hardening, standard-service starters and the other
integration/platform gates remain open. Older checkpoints below are historical.

AI development skills checkpoint: repository entrypoints now cover runtime apps, device adapters and package lifecycle. Structure and references are validated; their fresh-project app/adapter workflows pass, along with eight generated-app Windows checks and the 68-check adapter installation fixture. See [skill usage and evidence](ai-development-skills.md). This completes the initial skills deliverable; standard-service starter variants, remaining app window/clipboard APIs, lifecycle hardening and final integration/platform gates remain open. Older checkpoint paragraphs below are historical, including statements that skills had not started.

Adapter tooling checkpoint: the exported Rust SDK includes source/package schemas, a custom-service generator and native build/pack/validate commands. Package metadata validation is shared with the desktop. A fresh generated project builds outside the repository, interoperates with the production host, and installs through the Windows desktop fixture; all 68 checks pass. Standard-service starter variants, AI development skills and the remaining lifecycle/platform gates below are still required. Older checkpoint paragraphs record the scope at their respective dates.

Adapter SDK server checkpoint: a dependency-independent Rust crate now owns the shared wire contract and concurrent adapter server. Five contract tests and two production-host process tests cover dispatch, cancellation, fragmented input and shutdown. The source archive builds an example outside the checkout and interoperates with the host. Standalone package schemas/generation/packaging and generated-package desktop installation remain required; this is not the completed developer kit. See [the adapter SDK](adapter-sdk.md).

Built-in SSH composition checkpoint: the connection chooser can combine SSH with installed adapter sources, save public configuration and independently replace sources. SSH retains its endpoint-specific host-key review. Shared preparation leases close discarded sources. A real loopback SSH test passes console I/O after independent Files replacement; 64 Windows adapter checks pass, including mixed-profile secret omission and failed SSH preparation preserving the workspace. A valid mixed SSH GUI enrollment walkthrough, adapter tooling, AI skills and remaining lifecycle/platform gates are still required. Older checkpoint paragraphs below record their scope at that time.

Saved workspace checkpoint: the adapter connection dialog now saves/reopens/updates/removes persistent profiles with explicit service assignments. Native schema-based filtering omits credentials; atomic revision-checked storage preserves concurrent edits and corrupt files. Reopening reviews missing/changed adapters and never prefills fields reclassified as passwords. Three native profile tests, two frontend cases and 60 Windows adapter integration checks pass. Built-in SSH plus installed-adapter composition, adapter tooling, AI skills and the remaining platform/lifecycle gates are still required.

Process transfer checkpoint: installed adapters now implement the native streaming transfer contract with independent upload/download capabilities and optional directory readers. Byte chunks and directory pages are bounded; there is no total-file/tree cap. Handles own cleanup permits through cancellation and reject continuation after an uncertain offset. Eight separate-process transfer tests and 54 Windows adapter checks pass, including native queued file/folder copies. Persistent mixed profiles, built-in SSH plus installed-adapter composition, adapter tooling, AI skills and platform/lifecycle gates remain required.

Standard adapter services checkpoint: installed native processes can now supply text read/create/save, folder/rename/move/remove and provider-defined remote settings through the neutral contracts. File operations remain on their Files source; settings are independently assignable. Optional methods determine capabilities, revisions remain provider-owned, and malformed write replies report uncertain outcomes. Nine separate-process service tests and 51 Windows adapter integration checks pass, including text/settings conflicts and file relocation. The process transfer bridge, persistent mixed profiles, adapter tooling, AI skills and remaining platform/lifecycle gates are still required.

Public remote-settings checkpoint: `client.hostSettings` exposes provider fields and revision-checked apply through separate `host.settings.read` and `host.settings.write` grants. The desktop accounts for native work after app cancellation and combines its busy state with transfers. Seven SDK/RPC tests, permission-mapping tests, independent SDK packaging and the 56-check Windows installed-app walkthrough pass. See [runtime app remote settings](app-host-settings.md). Remaining process-adapter bridges, persistent mixed profiles, adapter tooling, AI skills and platform/lifecycle gates remain required.

Public transfer checkpoint: the SDK and broker now prepare upload/download/copy jobs, keep bytes in the native engine, expose coalesced progress and preserve authoritative outcomes after cancellation. The desktop owns busy state for pending selection and unfinished jobs, with a host retry action for failed cleanup of unseen tickets. Eight SDK/RPC tests, standalone SDK builds and the 49-check Windows installed-app walkthrough pass. See [runtime app transfers](app-transfers.md). Provider settings, remaining adapter bridges, persistent mixed profiles, adapter tooling, AI skills and the other gates remain open.

Public console checkpoint: installed apps now open byte-oriented consoles through the SDK using the namespaced `system.console` permission. Handles expose read/write, optional resizing and explicit close; source changes retire old handles. Native output acknowledgements provide backpressure without blocking input or cancellation. Pending opens, unfinished writes and unconfirmed cleanup remain accounted for. The 45-check Windows adapter walkthrough passed binary streaming through a separately built app and adapter, independent console closure, permission denial and reconnect retirement/new binding. See [runtime app consoles](app-console.md). Transfers/settings are tracked above; remaining adapter bridges and developer tooling are still required.

Operation availability checkpoint: native file status distinguishes browsing from text-document access. The broker and SDK discovery use this metadata, and bundled editor actions explain unsupported text access while preserving drafts. Targeted tests cover read-only text support and operation loss without invalidating directory reads. Both Windows probes passed 40 checks: the adapter probe covers browsing-only discovery, calls and editor controls; the installed-app probe checks the independently built example disables and restores its text action across reconnect acceptance. This does not complete the remaining service bridges or delivery gates.

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

Remaining runtime-app work includes cross-process catalog invalidation and running-window coordination, further app services, the standalone adapter SDK/schema/starters and AI development skills. The standalone app SDK and independent installed-adapter source replacement are implemented below. Local checks and Windows integration do not complete all delivery gates.

App-owned [local data and settings](app-storage.md) now have an explicit permission, paginated keys, revision-checked writes/deletes and cancellation. Data persists independently of packages and sessions. The SDK and Field Notes example use the brokered API.

The desktop now supplies [environment snapshots, service discovery and state events](app-events.md). Discovery uses the registered method map and keeps permissions separate from availability. Window-owned event journals provide bounded replay with explicit reset; SDK listeners share one cancelable stream. Reconnect approval and visibility changes are covered by the native integration fixture. Further window lifecycle actions remain required.

The runtime [text clipboard API](app-clipboard.md) has separate read/write grants, chunked delivery, captured read snapshots, complete-before-publish writes and window-owned cleanup. The desktop fixture injects synthetic clipboard contents to check the native frame/broker path without replacing the user's clipboard. Runtime file/custom-format clipboard services, further window lifecycle actions and the remaining developer tooling stay open.

The [native adapter process foundation](adapter-process.md) launches an external executable through a versioned protocol and supplies file/console service bridges plus arbitrary advertised method calls. Real local process tests cover failure isolation, cancellation, paged browsing and console ownership.

[Runtime adapter packages](adapter-packages.md) now have reviewed installation, immutable asset generations, revision-checked catalog changes, cross-process file leases, typed configuration and production workspace routing. The Windows desktop can assign files and terminal to independent installed adapter processes. Its native fixture covers installation/update/disable/removal, active-generation retention, service identity, unavailable capabilities and whole-workspace reconnect. Password fields are excluded from reconnect metadata. These checks use a separately compiled synthetic adapter, not real FTP/serial implementations.

Selected [custom adapter services](custom-services.md) now route through the installed-app broker and public SDK. The desktop reviews per-service grants, pins each call to its workspace/source, forwards cancellation and refuses stale completions. The Windows adapter fixture also installs an SDK example and tests denied access, JSON results, adapter errors and explicit reconnect approval. Vendor operations no longer require individual kernel methods.

Remaining adapter/composition work includes persistent composite profiles, mixing built-in SSH with installed adapters, remaining standard service bridges, process-tree containment, cross-platform evidence and the public adapter SDK/schema/starters. The complete objective and its other delivery gates remain open.

The native [workspace owner](workspace-bindings.md#prepared-source-replacement) supports transactional replacement of a prepared source with independent service lifetimes, expected-identity validation, preserved service-family assignments and capability changes. Retained old handles retire without affecting another source or another workspace's lease. Standard IPC captures and validates source identities, and queued transfers retain their provider. The desktop now exposes independent installed-adapter replacement with app acceptance, cancellation before commit, committed-result delivery after late cancellation and source-revision protection against stale polls. The 37-check Windows adapter fixture passed, including Files-only replacement with surviving console I/O and custom-service replacement requiring acceptance. Initialization cancellation and cleanup-warning UI walkthroughs remain explicit follow-ups.

Desktop window bindings change only for apps that declare the replaced services. Files resets provider-owned locations; Editor keeps drafts/undo but detaches the old save destination; unrelated Terminal handles remain stable. A [desktop source-switch fixture](workspace-bindings.md#desktop-source-switch-probe) checks these behaviors with synthetic providers. The native adapter fixture additionally checks the production command/UI and installed-app replacement acceptance.

The [standalone app SDK](app-sdk.md) now owns the runtime client and shared public types. Its packed distribution includes declarations, manifest/package schemas, a starter generator, build/validation commands, API/error guidance and a license. Verification installs the tarball into fresh projects outside the repository and builds the generated starter and lifecycle fixture through that installed SDK. No registry publication is claimed. Native integration exercises the independently generated app; adapter SDK/schema/starters and AI skills remain separate unfinished deliverables.

The public SDK now exposes [remote file services](app-files.md): text reads, create-only writes, revision-checked saves, paged directory iteration and folder/rename/move/delete actions. Every request carries the app window's accepted binding; retained documents, entries and listings cannot target a replacement connection. Field Notes can open and edit documents using this API. The 38-check Windows installed-app walkthrough passes multi-page listings, exact revision conflicts, a complete file-action sequence, denied file access and stale-operation refusal after reconnect. Directory contract tests cover 50,000 entries, cancellation, ownership and bounded retained resources; mutation tests preserve entry revisions and reject mixed-binding moves before dispatch. The walkthrough uses the externally installed SDK tarball and synthetic providers. Directory paging currently sits above the materialized native listing; transfer APIs and the process adapter text/mutation bridges remain required work. Public consoles are implemented in the checkpoint above.
