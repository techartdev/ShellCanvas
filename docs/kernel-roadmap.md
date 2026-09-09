# ShellCanvas system API and runtime extensions

Status: acceptance reviewed; final source verification pending, updated 2026-09-10. This is the current scope and completion
checklist for BASE-11. [Historical checkpoints](kernel-history.md) retain the
earlier implementation and test records. Their statements about pending work
describe that point in time, not the current backlog.

## Objective and design rules

Provide a small, coherent virtual-desktop API for bundled and community apps,
with reusable system UI and runtime-loadable apps, device providers and
connection adapters. Adding or updating an extension must not require rebuilding
the desktop. SDKs, schemas, starters, documentation and AI development skills must
let authors build independent packages from a clean checkout.

- Apps consume workspace services, not SSH sessions or OS-specific path syntax.
  Files, console, settings and custom services can come from different sources.
  Missing capabilities disable only the relevant actions.
- A versioned process protocol supports native device/protocol implementations
  without a dynamic-library ABI. Native adapters are trusted OS programs, not
  sandboxed UI packages. External UI uses isolated frames and a reviewed broker;
  trusted bundled app privileges must not leak into installed apps.
- Updates and source replacement preserve generation ownership. Old requests,
  handles and approvals must never act on a replacement package or host.
  Existing work retains its generation or is explicitly retired.
- Shared dialogs belong to their requesting window. A picker returns a
  provider-owned location; it neither writes bytes nor grants overwrite access.
- Keep source, packages, app data, credentials and temporary metadata separate.
  Examples use synthetic services without credentials. Cancellation cannot undo
  a completed mutation.

## Base API boundary and stopping rule

This is a desktop extension foundation, not a general-purpose operating system.
The base API families are now fixed: window/lifecycle, shared dialogs, app-owned
storage, clipboard, capability discovery, files/transfers, byte console, remote
settings and namespaced custom service calls. Complete and simplify those
contracts; do not add new API families while closing BASE-11.

An app uses only the services it needs. A local utility needs no remote-file or
console implementation. An adapter implements initialization and dispatch for
its advertised services, using the SDK for framing and request lifetime. A
console-only device supplies no filesystem, clipboard or settings service.
Read-only files do not require mutation or transfer support. Custom device
operations use the existing namespaced call contract rather than new kernel APIs.
The core owns package review, routing, grants, source identity, shared windows
and host-side cleanup. Authors own their app behavior or actual device operations,
including the consistency and cancellation rules of the operations they expose.

The stopping test is an independently built app and an independently built
adapter installed without rebuilding the desktop, useful partial capabilities,
mixed-source composition, predictable errors and replacement/close behavior,
and matching SDKs, schemas, starters, documentation and AI skills. Verify these
on the supported Windows desktop. Keep unsupported native platforms gated and
document their missing evidence; do not equate portable contracts with a tested
Mac/Linux release. Fix correctness issues in the delivered contracts, but do not
make completion depend on every possible protocol, clipboard format or platform.

The remaining checklist below distinguishes current-contract validation from
later expansion. Multi-item Cut, custom clipboard formats, cross-process
clipboard exchange and native Mac/Linux rollout are follow-up milestones, not
reasons to keep expanding this API. Responsive desktop checks remain in scope;
physical tablet/mobile product polish does not.

## Implemented capabilities and evidence

Implemented means the stated behavior and platform, not completion of the goal.

| Area                     | Current implementation                                                                                                                                                         | Contract and evidence entrypoint                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System UI                | Window-owned message boxes, Open/Save pickers, revision-checked Save As, focus/cancellation and bundled Editor adoption                                                        | [System API](system-api.md); generated app and desktop fixtures                                                                                          |
| App lifecycle            | Environment/discovery/events; window snapshots and controls; guarded close; revision-checked app data/settings                                                                 | [Window API](app-window.md), [events](app-events.md), [storage](app-storage.md)                                                                          |
| Remote app services      | Text documents, file actions and paged directory API; byte consoles; native transfer jobs; remote settings and namespaced custom calls                                         | [Files](app-files.md), [console](app-console.md), [transfers](app-transfers.md), [settings](app-host-settings.md), [custom services](custom-services.md) |
| Clipboard                | Text and RGBA images; Windows native file export/paste; remote Copy and single-item Cut shared between installed apps and bundled Files within the original workspace/provider | [App clipboard](app-clipboard.md), [native clipboard](system-clipboard.md); injected clipboard fixtures and native transfer tests                        |
| Runtime apps             | Persistent reviewed install/update/disable/remove, retained code/grants and dirty/busy guards; fresh launch checks and cross-process removal leases                            | [Runtime apps](runtime-apps.md); Windows installed-app and two-process fixtures                                                                          |
| App boundary             | Owner-bound resource loader, isolated document, guarded native IPC, enforced broker and foreign/stale handle refusal                                                           | [Runtime apps](runtime-apps.md); Windows negative fixtures. Other platforms remain gated                                                                 |
| Runtime adapters         | Reviewed packages, immutable asset generations, cross-process leases, typed configuration and concurrent versioned protocol                                                    | [Packages](adapter-packages.md), [process contract](adapter-process.md); process and Windows installation fixtures                                       |
| Adapter services         | Optional directory/text/file actions, streamed transfers, byte console, settings and custom services                                                                           | [Process contract](adapter-process.md); production-host service/transfer tests                                                                           |
| Composition              | Built-in SSH alongside installed adapters, explicit assignments, secret-free profiles, independent replacement and accepted app rebinding                                      | [Bindings](workspace-bindings.md), [profiles](workspace-profiles.md); Windows fixture and loopback SSH test                                              |
| Windows process lifetime | Suspended startup into an owned job, descendant termination and confirmed exits; retained assets after unconfirmed cleanup                                                     | [Adapter lifecycle](adapter-process.md); real descendant and supervisor-termination tests                                                                |
| Developer kit            | Independent TypeScript app and Rust adapter SDKs, schemas, app/custom/standard-adapter generators, build/pack/validate commands and examples                                   | [App SDK](app-sdk.md), [adapter SDK](adapter-sdk.md); exported packages built outside the checkout and installed through fixtures                        |
| AI skills                | Portable app, adapter and package lifecycle instructions with validated links and executed fresh-project workflows                                                             | [AI development skills](ai-development-skills.md)                                                                                                        |

## Remaining implementation and integration gates

- [x] **Current clipboard contract:** single-item Cut/move intent with authoritative
      outcomes, publication permissions and honest cancellation behavior.
      Preserve source identity, grants and cancellation ownership. A bundled Cut
      now pastes through the public API as a move with a native exclusive reservation,
      provider identity checks and authoritative outcome handling. Native and SDK tests
      cover cancellation, failed/abandoned dispatch and tracked relocation. The 91-check
      Windows desktop fixture covers Cut in both directions between bundled Files
      and installed apps, publication/move-grant denial
      and cleanup failure/retry with retained close guards. Public `clipboard.cutFile`
      publishes one move reference with separate Move/Download authority. Verify
      live OS image/file interoperability separately from injected fixtures.
      The [live Windows image exchange](live-image-clipboard-validation.md) now
      passes both directions with an independent .NET reader/writer and restores
      the original clipboard. The independent [live Windows file exchange](live-file-clipboard-validation.md)
      also passes: lazy OLE streams, exact bytes/hashes, nested/empty folders and
      native file-list decoding. Its successful repeat restored the current text
      clipboard; the earlier restoration-verification failure is retained explicitly.
      These are layered OS and SDK checks, not new Explorer UI or live-host claims.
      Upload/Download chooser selections now use one catalog-backed batch without a
      fixed root-count limit; active jobs and streams remain bounded separately.
- [ ] **Follow-up: non-Windows adapter lifetime:** ordinary descendants on close,
      canceled/rejected startup, crash/protocol failure, dropped ownership and
      supervisor termination. Preserve unrelated processes and retain assets until
      cleanup is confirmed. Current non-Windows cleanup covers only the direct child.
- [x] **Diagnostics and crash recovery:** bounded, useful adapter diagnostics
      without credentials/configuration leaks; recover stale staging resources
      without disturbing active generations. Versioned review staging recovery is
      implemented: an OS lease protects copying/review, and collection preserves
      other processes and running generations. A real process-termination test
      verifies recovery on Windows. Connection diagnostics retain 256 typed events
      for each of 32 recent attempts, including failed startup, with refresh and
      report export in the desktop. Real process tests cover privacy and cleanup;
      the Windows fixture verifies failed preparation and retained live connections.
      See [diagnostics](adapter-diagnostics.md). Legacy/unrecognized staging is
      preserved rather than guessed abandoned; other-platform evidence stays open.
- [x] **Standard-service starters:** independently buildable Files, Terminal and
      Remote settings examples with discovery, cancellation, resource ownership and
      production-host verification. `init --template files|console|settings` selects
      a synthetic service; omission retains custom echo/wait. The independent SDK
      verifier builds and packages all four outside the checkout, checks source and
      package schemas, and passes six standard-service tests against the production
      host. See [starter behavior and evidence](adapter-sdk.md#standard-service-starters).
- [x] **Incremental native browsing:** bundled Files, system file pickers and the
      Copy/Move destination dialog now use provider pages and cancellation without
      a total-tree/file cap. Transfers use incremental traversal and a disk-backed
      metadata catalog.
      [Native directory readers](native-directory-readers.md) now supply demand-driven
      adapter and SFTP pages with cancellation/cleanup and source replacement checks.
      Native IPC registration, app permission routing and public broker integration
      preserve that demand and ownership. The browser fixture passes all 13
      progressive-discovery and 50,000-entry checks at 1360×900 and 800×900,
      including refresh-selection retention, keyboard/scroll access to the final
      entry, shared pickers and cleanup. Each final view renders 29 rows; retained
      viewport reports are linked from the native directory reader guide.
- [x] **Composition workflow validation (Windows):** the 12-check
      [connection UI fixture](connection-ui-validation.md) verifies mixed-source
      enrollment through host-key review, initialization cancellation, stale callbacks,
      late-session cleanup, committed replacement warnings and partial file failure
      with the console preserved. It uses synthetic services through the production
      UI; real SSH and native adapter processes are checked separately. The native
      adapter fixture covers custom-API-only workspaces and independent sources.
      The service-availability walkthrough covers surviving files/console access;
      the retained 10-check source-switch result covers drafts, undo history,
      console input and Save As against the replacement source. This is layered
      contract/UI evidence, not a new live-device or non-Windows claim.
- [ ] **Follow-up: native platform evidence:** build/run macOS and Linux, then verify actual
      app-frame isolation, broker, catalog leases, custom protocols and cleanup before
      enabling installed UI there. A shell build does not establish runtime isolation.
- [x] **Interaction/accessibility:** dialogs, keyboard/focus, guards and partial
      capabilities across desktop/tablet layouts. Compact Windows fixtures cover
      800×900 and 1360×900; physical tablet/mobile behavior is follow-up product work.
      The current browser walkthrough verifies compact Open/Save/folder pickers,
      keyboard selection, safe replacement defaults and focus restoration. It found
      and fixed lost opener focus across the compound Save As replacement review;
      a two-owner regression checks cancellation and successful replacement.
- [x] **Documentation and API review:** align SDK declarations, method/grant
      discovery, schemas, examples, skills and guides. Remove superseded pending-work
      claims while preserving historical evidence. Review errors, cancellation and
      lifetime rules from an independent extension author's perspective.
      The [eight-area acceptance audit](kernel-acceptance.md) maps the fixed
      contract to implementation/runtime evidence and its explicit limits.
      Fresh independent app and all four adapter starter builds pass; public
      guides keep permissions, capability discovery, ownership and cancellation
      distinct. No new API family or mandatory device service was added.

## Verification and completion audit

See [verification](verification.md) for report semantics and commands:

```sh
npm run verify -- --native
npm run verify:sdk
npm run verify:adapter-sdk
```

The first fingerprints source and runs local checks plus the platform's debug
build. The SDK commands prove consumption outside the checkout. None alone proves
GUI behavior, device support or platform isolation. Native fixture instructions
are in [runtime apps](runtime-apps.md) and [adapter packages](adapter-packages.md).

Windows source checkpoint `458144a` passed 258 frontend tests, 186 Rust tests
with two intentional live probes ignored, SDK checks, formatting, Clippy and the
normal desktop build. Final verification including the new opt-in file probe
is pending. Current runtime evidence and each checkpoint's limits are indexed
in the [acceptance audit](kernel-acceptance.md). Synthetic clipboard/provider
fixtures remain distinct from the live Windows OS clipboard probes.

[Mac validation](macos-validation.md) was performed on a 2012 Intel MacBook Air
with Catalina 10.15.8. The exact `ddbb580` repository passed frontend and native
compilation using isolated Node 20.20.2, but the first launch aborted in an
upstream WebKit/objc2 debug check. A scoped compatibility build opened the native
window but hit a JavaScript syntax error before rendering the desktop.
This does not enable installed UI packages or establish general Mac support.

The acceptance audit covers independent installation without core rebuilds,
preserved work during updates/switches, denied/foreign/stale operations, partial
capabilities and cleanup across all eight delivery areas. Final clean-source
verification is the remaining closure step; the follow-ups below do not expand it.

## Product work beyond this core goal

Actual Serial, Telnet, FTP, SMB and vendor API adapters need representative devices
and protocol-specific tests. WispCrew/AI assistant integration, a marketplace,
optimized/signed distribution, mobile releases and hosted web service remain
product backlog items. The core must permit these paths without forcing them
into this milestone. See [the backlog](../BACKLOG.md) and [providers](providers.md).

Clipboard follow-ups include multi-item Cut, custom formats, cross-process
selection exchange and more interruptible native preparation. Existing APIs must
still retain cleanup ownership and report uncertain outcomes correctly. Native
Mac/Linux runtime validation and descendant cleanup are prerequisites for enabling
extensions on those platforms, not for declaring the Windows base API usable.
