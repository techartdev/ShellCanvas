# Work after the base API goal

Updated 2026-09-10, after commits `fd093b7` (Catalina compatibility) and
`6d9ce80` (user confirmation). This is the current handoff of unfinished work,
including work deliberately excluded from the goal. It supplements the original
IDs in [BACKLOG.md](../BACKLOG.md) and takes precedence over older checkpoint
paragraphs describing something as pending. No new goal or implementation work
is started by this list.

## Where we stopped

- **Complete within the Windows scope:** the BASE-11 extension foundation,
  runtime app/adapter installation, composition, shared services, SDKs, schemas,
  starters and authoring skills. See the [eight-area acceptance audit](kernel-acceptance.md).
- **Already delivered:** Files/Terminal/Editor, saved hosts, independent host
  workspaces, context menus, preferences, reconnect, file actions, transfers,
  remote multi-file/folder Copy/Paste, Windows file clipboard integration and
  incremental tree discovery without the old entry/depth caps. Do not re-add
  those as unimplemented tasks because an earlier checkpoint predates them.
- **Mac follow-up completed:** the Catalina startup failures, clipped desktop,
  core spacing and missing modal-dialog API were addressed. Both desktop layout
  and Settings were confirmed by the user; actual WKWebView layout/dialog probes
  passed. This is not complete Mac platform acceptance. See [Mac evidence](macos-validation.md).
- **Verification snapshots:** goal closure records 258 frontend and 186 Rust
  tests plus SDK checks, formatting, Clippy and a Windows build. The later Mac
  compatibility change passed 261 frontend tests and Mac/Windows builds. These
  are separate checkpoints, not one combined full verification run.

Status labels below mean **Validation** (behavior exists, missing real evidence),
**Implementation** (new behavior or a known platform gap), or **Decision** (scope
must be chosen first). Every unchecked item remains open. Priorities are a
suggested order, not a commitment to complete every item.

## First: everyday reliability and native acceptance

- [ ] **POST-01 — Physical connection interruption. Validation.** Exercise actual
      network loss and restoration during terminal I/O, browsing, save, upload,
      download, folder discovery, remote copy/move and Explorer's deferred paste.
      Include slow links and cancellation during authentication/provider startup.
      Done when drafts survive, unaffected sources remain useful, partial results
      and uncertain publication are honest, cleanup is verified, and retries cannot
      duplicate mutations. Requires disposable targets/data and a controlled outage.
      Maps to CORE-04/05/06; [recovery](connection-recovery.md), [transfers](transfers.md).
- [ ] **POST-02 — Remaining Windows GUI workflows. Validation.** Close the gaps
      between service/fixture tests and actual keyboard/native UI: incoming file
      Ctrl+V, local/remote Cut interoperability, a complete folder-paste walkthrough,
      native batch deletion, Copy cancellation, editor relocation after file/folder
      moves, selected-substring preview copying, dirty-draft reconnect and delayed
      clipboard failure. Done when generated data has exact readback, source
      preservation/deletion matches the chosen action, and focus/drafts/close guards
      survive failures. Do not repeat already-passed happy paths without a reason.
      Maps to CORE-03/05a/08/09b; [native files](native-file-workflows.md),
      [clipboard evidence](system-clipboard.md).
- [ ] **POST-03 — Two real hosts together. Validation.** Open independent
      workspaces against two actual devices, switch repeatedly, reconnect/close one,
      and keep the other terminal, files and drafts usable. Done when routing and
      state isolation are demonstrated beyond the existing protocol fixtures.
      Maps to CORE-07; [bindings](workspace-bindings.md).
- [ ] **POST-04 — Remote settings writes. Validation.** On a disposable systemd
      host, test actual hostname/timezone apply, readback, concurrent changes,
      permission refusal and unprivileged authorization. Done when the result is
      verified and the original state restored. Existing live evidence is read-only;
      do not use a production host for convenience. Maps to CORE-10b;
      [remote settings](remote-settings.md).
- [ ] **POST-05 — SSH trust enrollment walkthrough. Validation.** Exercise native
      unknown-host review, accept/cancel/expiry, reconnect and changed/revoked-key
      refusal on a controlled SSH server. Done when the UI and stored trust match the
      exact endpoint/key and rejection leaves existing sessions intact. Loopback and
      synthetic coverage already exist. Maps to CORE-02; [trust](ssh-host-trust.md).

## Native Mac and Linux rollout

- [ ] **POST-06 — Mac client everyday acceptance. Validation.** Test SSH connect,
      Files, multiple terminals, resizing, editor saves/conflicts/quit guards,
      reconnect, native pickers, transfers, text/image clipboard and keyboard
      shortcuts. Inspect the remaining dialogs, compact layouts, scale factors and
      long sessions on Catalina; test a modern macOS/Apple Silicon machine when
      available. Done when the exact tested OS/architecture/build and remaining
      visual differences are recorded. The user-confirmed launch/Settings fix is
      complete, not a task to repeat. Maps to SHIP-02; [Mac record](macos-validation.md).
- [ ] **POST-07 — Linux client baseline. Validation and implementation as needed.**
      Build/run on a chosen supported distribution, then test the same core flows,
      system clipboard, native dialogs, fonts, keyboard and desktop integration.
      Select and record X11/Wayland coverage; do not infer it from Windows/browser
      checks. Maps to SHIP-02.
- [ ] **POST-08 — Non-Windows adapter process ownership. Implementation.** Current
      cleanup covers the direct child only. Implement platform-appropriate ownership
      and termination of ordinary descendants on close/drop, canceled or rejected
      startup, protocol failure, adapter crash and supervisor termination. Done when
      unrelated processes survive and package assets remain retained until cleanup
      is confirmed. Maps to BASE-11 follow-up; [process contract](adapter-process.md).
- [ ] **POST-09 — Non-Windows extension boundary. Validation and implementation
      as needed.** Prove installed UI isolation, resource ownership, denied native
      IPC, broker permissions, stale/foreign handle refusal and lifecycle cleanup in
      each native webview. Keep installed third-party UI gated until it passes; a
      working bundled Mac desktop is not sufficient. Maps to EXT-02;
      [runtime boundary](runtime-apps.md).
- [ ] **POST-10 — Cross-platform package lifetime/recovery. Validation.** Repeat
      package review/install/update/remove, simultaneous desktop processes, retained
      generations and supervisor-crash staging recovery on Mac/Linux. Done when
      active packages and another process's resources are preserved, diagnostics do
      not disclose credentials, and abandoned owned staging is collected safely.
      Coordinate with POST-08/09; [packages](adapter-packages.md),
      [diagnostics](adapter-diagnostics.md).

## File, clipboard and recovery features deliberately deferred

- [ ] **POST-11 — Multi-item Cut. Implementation.** Extend the current single-item
      move intent with per-item results, one authoritative dispatch per item,
      partial failure/cancellation and source-generation ownership. Done when bundled
      Files and SDK apps interoperate without replaying uncertain moves. Maps to
      CORE-05c; [clipboard contract](app-clipboard.md).
- [ ] **POST-12 — Cross-host copying and cross-device moves. Implementation.**
      First support explicit source/destination bindings for copy; then separately
      decide deletion-after-transfer semantics. Today remote Copy/Paste stays within
      one file-service binding, and local/remote Cut across devices keeps the source.
      Done when destination verification precedes any authorized source deletion and
      failures never silently turn copy into move. Maps to CORE-05c/LINK composition.
- [ ] **POST-13 — Native file clipboard adapters for Mac/Linux. Implementation.**
      Add each platform's file/folder import/export behavior, including deferred data
      and cancellation where supported. Done when Finder/selected Linux file managers
      exchange exact bytes and empty/nested folders through actual OS clipboard paths.
      Text/image APIs alone do not satisfy this. Maps to CORE-05c.
- [ ] **POST-14 — Broader clipboard interchange. Implementation/decision.** Treat
      each as a separate increment: incoming virtual files from other applications,
      remote file references between separate ShellCanvas processes, image-to-file
      paste, custom formats and optional clipboard history. Define format ownership,
      grants, source lifetimes and failure behavior before adding APIs. Existing
      cross-process package leases are not cross-process clipboard support.
- [ ] **POST-15 — Transfer restart and scratch recovery. Implementation.** Recover
      abandoned transfer catalogs/temp files after crashes without touching active
      work or unrelated files. Design persisted jobs/resume separately; queues are
      currently in memory. Done when crashes at discovery, streaming and publication
      have tested recovery outcomes, including multiple desktop processes. Package
      staging recovery already exists; transfer scratch recovery does not.
      Maps to CORE-04/05e; [tree transfers](system-clipboard.md).
- [ ] **POST-16 — Transfer conflict refinements. Implementation/decision.** Choose
      explicit replacement, folder merging, renamed duplicates and safe retry/resume
      behavior as individual tasks. Today destinations must be absent and completed
      portions of canceled folders remain visible. Done when reviewed collisions,
      partial results and changed destinations are handled without silent overwrite.
      Metadata preservation is optional provider-specific work, not an existing
      guarantee. Maps to CORE-04.
- [ ] **POST-17 — Recursive deletion and action scale. Implementation/decision.**
      Design reviewed nonempty-tree deletion, symlink/special-file policy, progress,
      cancellation and irreversible partial results. Review the existing batch-delete
      and relocation-tracking bounds separately from the already-removed folder
      discovery caps. Done when large selections stay responsive and unsupported
      cases have explicit outcomes. Maps to CORE-05/05a.
- [ ] **POST-18 — Optional draft recovery. Implementation/decision.** Persist
      recoverable editor drafts with explicit storage/retention policy and correct
      original host/file identity. Done when restart/reconnect cannot save recovered
      text to a replacement host or overwrite newer remote content. Larger files,
      additional encodings and richer editor features are separate choices; the
      current UTF-8 editor's 256 KiB bound is documented. Maps to CORE-09b.

## Product polish and authentication

- [ ] **POST-19 — Host profile organization. Implementation.** Custom groups/tags,
      import/export, optional connection history, provider preferences and versioned
      adapter-profile migrations. Search, saved/imported grouping and CRUD are
      already delivered. Done when imports validate, duplicate/corrupt data is
      recoverable and exported profiles omit credentials. Maps to CORE-01b;
      [host profiles](host-profiles.md), [workspace profiles](workspace-profiles.md).
- [ ] **POST-20 — Authentication and trust management. Implementation/decision.**
      Trusted-host management UI, SSH agent, keyboard-interactive and certificate
      support remain open. Decide optional credential-vault/key storage and migration
      separately; passwords/passphrases must not enter profile JSON. Done when the
      selected auth method has real positive, cancel and refusal tests. Maps to CORE-02.
- [ ] **POST-21 — Window and accessibility polish. Implementation/validation.**
      Drag-to-edge previews, touch resize handles and optional persisted layouts;
      keyboard/screen-reader audit, focus visibility, high DPI and platform shortcuts.
      Preserve toolbar/dock reservations and the approved visual design. Done when
      actual native and touch tests cover the selected feature; browser compact
      layout checks alone do not establish mobile usability. Maps to UX-01/SHIP-02/03.

## Real device and transport coverage

Implement only the next adapter justified by an available target. SDK examples
are contract demonstrations, not production device support.

- [ ] **HOST-01 — Linux variants / Raspberry Pi OS.** Real distribution tests,
      including Debian/Ubuntu, Alpine/BusyBox, unprivileged users, missing utilities
      and disabled SFTP. Publish exact coverage, not a generic Linux claim.
- [ ] **HOST-02 — Remote macOS.** Windows-to-Mac file browsing and a live shell
      were user-confirmed. Darwin/BSD-specific detection, file writes/transfers,
      shell negotiation, capability failures and lifecycle still need a provider
      acceptance pass. This is separate from running the client on a Mac.
- [ ] **HOST-03 — Windows OpenSSH.** Default shell detection, PowerShell/cmd,
      drive/path semantics, SFTP, PTY and lifecycle against an authorized Windows host.
- [ ] **HOST-04 — One appliance.** Select a specific MikroTik/RouterOS or other
      device/version and test its real available services. No forced POSIX, SFTP or
      writable filesystem assumptions; unsupported apps must explain why.
- [ ] **LINK-01 — Serial.** Port configuration/ownership, byte I/O, unplug/replug,
      cancellation and resource release on real hardware or a loopback.
- [ ] **LINK-02 — Telnet.** Negotiation, device console behavior, timeouts and
      explicit connection security presentation; never silently downgrade SSH.
- [ ] **LINK-03 — FTP files.** Listing/path/encoding variants, transfer failures
      and cancellation on a disposable server. Demonstrate composition with a
      separate console transport.
- [ ] **LINK-04 — One device API.** A documented real target with useful typed
      capabilities, credentials and partial-failure tests, without requiring a shell.

## Extensions, AI and distribution

- [ ] **EXT-03 — Package distribution.** Publisher authentication, signatures,
      explicit rollback tooling and marketplace/catalog distribution. Existing
      install/update/remove, integrity checks and retained generations are complete.
      Gate: trust and update/recovery behavior is verified before public distribution.
- [ ] **POST-22 — SDK release/versioning. Decision/implementation.** The public
      contracts are provisional and SDKs are not published to registries. Choose
      compatibility policy, API/data migrations, publication and support matrix.
      Validate fresh third-party author workflows; simplify problems found without
      requiring every adapter to implement all services. Maps to EXT-01/COMM-01.
- [ ] **AI-01 — WispCrew integration spike.** Reuse assessment is done; runtime
      integration is not. Compare optional connection versus portable extraction,
      then measure size/startup/cancellation with a fake streaming model. Keep Files
      and Terminal independent of AI and any Node sidecar. See [assessment](ai-integration.md).
- [ ] **AI-02 — Optional assistant app.** Model setup, streaming/cancel,
      per-host conversations and user-selected context, after AI-01. No automatic
      export of terminal/file content.
- [ ] **AI-03 — Assistant tools.** Read-only tools first, then reviewed writes or
      commands with session-bound approval, cancellation, audit outcomes and budgets.
      Do not inherit WispCrew's local shell/filesystem defaults.
- [ ] **SHIP-02 — Desktop release packages.** Optimized installers/app bundles
      for chosen Windows/Mac/Linux versions, launch/exit/uninstall, dependency and
      size/startup measurements, signing/notarization and update strategy. Include
      a decision on maintaining Catalina's explicit debug workaround. Existing debug
      executables are not signed production releases. Gate: the exact release commit
      passes [verification and release checks](verification.md) on each claimed platform.
- [ ] **SHIP-03 — Native tablets, then phones.** Android/iOS feasibility with SSH
      lifetime, key import, IME, external keyboards and touch management on actual
      devices. Phone-specific refinement follows tablet proof.
- [ ] **SHIP-04 — Optional hosted web product.** Gateway authentication, per-user
      host authorization, private-network access, credentials and deployment model.
      Requires a design/threat review and prototype; the local browser design preview
      is not a working hosted SSH service.
- [ ] **POST-23 — Hosted CI. Decision/implementation.** Choose provider/platform
      matrix, secret handling and artifact retention. The local verification runner
      is delivered; hosted workflows were not set up. Keep live-host/clipboard tests
      explicitly opt-in. Maps to SHIP-01/02.
- [ ] **COMM-01 — Community release.** Contribution/issue templates, supported
      systems, release notes, SDK distribution and public-repository readiness.
      Name/domain/trademark checks and launch timing remain decisions. Existing SDK
      starters and contributor guidance should be improved, not recreated.
- [ ] **POST-24 — Commercial boundaries. Decision.** Paid desktop/mobile/web or
      hosted offerings, private components and pricing remain undecided. Current
      MPL-2.0 core licensing and the private source repository are established; do
      not change them or promise a paid tier as part of closing this backlog.

## Boundaries to preserve

The core API goal stays closed. No new mandatory service family, calculator or
other demonstration app is needed to prove it again. Providers expose only what
their devices can do; mixed transports remain optional composition.

Not every documented limitation is a defect or a promised feature. OS clipboard
descriptor/path limits, bounded concurrent workers and RPC frames are different
from total tree-size caps. SFTP metadata revisions are not immutable snapshots or
distributed compare-and-swap. Cancellation does not undo completed mutations.
Native adapters are trusted OS programs, not sandboxes. Do not turn these into
universal guarantees while implementing a follow-up.

When resuming, choose one unchecked item, confirm its target/device and observable
completion gate, then update this record with code/evidence/platform. Start with
POST-01 through POST-06 according to available test access, rather than expanding
the API or starting all future product branches at once.
