# BASE-11 acceptance audit

Reviewed 2026-09-10 against the [fixed scope](kernel-roadmap.md#base-api-boundary-and-stopping-rule).
The acceptance target is the Windows desktop extension foundation. This audit
does not turn synthetic adapters into supported production protocols or a
successful compilation into a tested Mac/Linux release.

## Eight delivery areas

| Area                 | Delivered boundary                                                                                                                                  | Evidence                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System UI            | Window-owned message/Open/Save dialogs, text Save As, focus and cancellation                                                                        | Generated SDK app: eight Windows checks; compact browser Open/Save/folder/replacement walkthrough; two-owner Save As focus regression in `src/system-dialogs.test.ts` |
| App services         | Window/lifecycle, storage, discovery/events, files/transfers, clipboard, console, settings and custom calls; grants and accepted source identity    | 91-check installed-app desktop fixture, 88-check compact checkpoint; SDK/broker/native tests; live Windows image and file clipboard probes                            |
| Runtime apps         | Reviewed install/update/disable/remove without a desktop rebuild; existing windows retain code/grants and drafts                                    | Installed-app lifecycle fixture; 11-check two-process catalog test, including termination releasing leases                                                            |
| Extension boundary   | Isolated app frame, owner-bound resources and guarded broker; stale, foreign and denied calls refused                                               | Native Windows negative/frame fixtures and broker tests; unsupported native platforms remain gated                                                                    |
| Adapters/providers   | Versioned native process protocol; optional standard/custom services, typed configuration, diagnostics and Windows process ownership                | Native adapter installation/service fixtures, real process lifetime/recovery tests, independent SDK host tests                                                        |
| Composition          | Explicit source roles, partial capabilities, independent replacement and preserved work                                                             | 12-check connection UI fixture; ten-check source-switch fixture; native mixed-source and built-in loopback SSH tests                                                  |
| Developer experience | Independent TypeScript app SDK and Rust adapter SDK, shared parsers/schemas, generators/build/pack/validate; custom/Files/console/settings starters | Fresh outside-checkout SDK exports/builds; production-host tests for generated adapters; generated app/adapter installation fixtures                                  |
| AI skills            | App, adapter and package author workflows pointing to public contracts                                                                              | Three portable skill entrypoints, valid relative links, documented commands executed against fresh generated projects                                                 |

These are complementary layers of evidence. The installed-app clipboard fixture
uses injected services; the [live image](live-image-clipboard-validation.md) and
[file](live-file-clipboard-validation.md) probes exercise Windows itself. Compact
browser evidence is not a physical tablet test. Native adapters run as trusted
OS programs; UI grants do not sandbox their device access.

## Retained evidence index

Local reports are deliberately ignored by Git; reproduction commands and fixture
sources are maintained in the linked guides. Read each report's scope rather than
adding all check counts together as if they came from one test run.

- `.local/native-extension-probe/desktop-1360-public-cut.json`: 91 checks,
  actual frame/SDK/broker/UI with synthetic host/clipboard services.
- `.local/native-extension-probe/desktop-800-cut-cleanup.json`: preceding
  88-check compact checkpoint.
- `.local/native-extension-probe/catalog-coordination-result.json`: 11 checks
  across separate desktop processes.
- `.local/native-extension-probe/ai-skill-starter-result.json`: eight checks
  installing/using the independently generated app.
- `.local/native-extension-probe/connection-ui-result.json` and
  `.local/source-switch-probe/windows-result.json`: enrollment/partial failure
  and source replacement preserving drafts/console work.
- `.local/native-adapter-probe/`: generated SDK, standard/custom services,
  source lifetimes, profiles, transfers and built-in SSH fixture reports;
  [adapter package guide](adapter-packages.md) describes the checkpoints.
- `.local/ui-validation/directory-800.json` and `directory-1360.json`: 13 checks
  each, 50,000 entries with only 29 final rendered rows, paging, selection,
  keyboard navigation and picker cleanup. `save-as-focus.json` records both
  canceled and successful replacement review; `compact-open-picker.png` is
  the actual 800×900 rendered picker.
- `.local/sdk-verification/result.json` and
  `.local/adapter-sdk-verification/latest.json`: successful fresh independent
  exports/builds, schemas and generated standard-service interoperability.
- `.local/live-image-clipboard/result.json` and
  `.local/live-file-clipboard/result.json`: live Windows interchange, with
  limitations and restoration history documented in their guides.

## Author-facing consistency review

The public SDK exports and command guides match the supported service families.
Method discovery distinguishes permission from service availability; the broker
enforces both. Shared-dialog controls use `{ signal }`; other SDK methods follow
their documented optional `AbortSignal` argument. Events return a synchronous
unsubscribe function. Console/transfer handles retain explicit close ownership.
Text/image clipboard methods and native file clipboard methods have distinct
grants and outcomes. A picker chooses a location and never writes or authorizes
overwrite. Canceled or uncertain mutations must not be blindly replayed.

No feature requires every extension to implement the whole API. A local app
can use only dialogs/storage. An adapter implements initialization plus dispatch
for its advertised services; standard starters deliberately omit unsupported
features. SDKs handle framing and host integration. Actual device consistency,
cancellation and authorization belong to the adapter implementing those actions.
The public SDK remains provisional and is not published to a registry.

## Stop here

No new API family, mandatory transport or bundled demonstration app is needed
for this milestone. Real Serial/Telnet/FTP/SMB/vendor adapters, an AI assistant,
marketplace, signed distribution, mobile/hosted products, multi-item Cut,
foreign virtual-file input and cross-process clipboard exchange remain separate
product work. Mac/Linux native isolation and descendant cleanup must be verified
before enabling installed UI there. See [backlog](../BACKLOG.md).

The final source verification result is recorded in the kernel roadmap. Closure
requires that check to pass; this audit does not substitute for it.
