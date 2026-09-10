# Standalone assistant and repository installation

Completed Windows product proof, 2026-09-10, following the closed base API
milestone. The independently installed assistant was verified with real model
calls and host operations, as well as deterministic protocol and broker tests.

## Decisions

- The user selected an OpenAI-compatible endpoint, API key and model.
- Live tests used the official OpenAI Responses endpoint with the user's selected
  `gpt-5.6-terra`. The user entered the API key in the desktop connection dialog.
  Responses was added after Chat Completions rejected reasoning with tool use.
  Both protocols remain supported; the model remains user-configurable.
- The assistant may have a public GitHub repository (explicitly approved on
  2026-09-10). The user purchased shellcanvas.com and pointed it at evtinsait.
  A documentation website and making the core app repository public are later
  steps; keep the future website repository private.
- Assistant UI, history and agent/tool-loop behavior belong in an independent app
  project consuming the packaged SDK, with no imports from desktop internals.
- The desktop supplies reviewed repository installation and necessary generic
  permission/credential/network primitives. App code does not get unrestricted
  native IPC. Model secrets are not manifest fields or conversation storage.
- A root repository descriptor points to a prebuilt self-contained package and
  its SHA-256. Fetch repository files directly; no app server, npm install scripts
  or GitHub REST/GraphQL dependency is required for installation. Source builds
  remain a developer operation. Review the exact fetched package before executing.
- Preserve the modern desktop appearance. Missing file/console/device services
  disable the corresponding tools, not the whole assistant. Attachments and
  clipboard are real user workflows, not inert buttons.

## Completion checklist

- [x] Repository descriptor/schema and authoring command; malformed manifests,
      unsafe paths, mismatched identities/digests and interrupted downloads rejected.
- [x] Apps UI accepts a GitHub repository/ref, shows source/version/permissions,
      installs the reviewed bytes, and supports reviewed updates with retained windows.
- [x] Independently built assistant repository/package installed through that UI
      without rebuilding the desktop for each app change.
- [x] Polished messaging interface: streaming, cancel, errors/retry, model setup,
      persistent conversation history, draft/close behavior and host identity.
- [x] Actual OpenAI-compatible model round trip and tool loop, including iteration
      limits, cancellation, partial failures and structured tool results.
- [x] Useful host tools for discovery/files and command-capable devices, with
      concrete mutation review, original binding ownership and honest partial support.
- [x] Attachments from file selection and clipboard, image/text support, previews,
      removal, understandable limits and deliberate context submission to the model.
- [x] Endpoint/key handling, denied permissions, unavailable capabilities, host
      switch/reconnect, failed tools and secrets/history separation verified.
- [x] App development, repository packaging and assistant operating documentation
      and AI skills tested against a fresh independent checkout.
- [x] Native installed-window visual/workflow checks, SDK regression checks and
      final requirement-by-requirement audit, with real-model evidence distinguished
      from deterministic fixtures. Restore the normal desktop build after probes.

Do not mark the goal complete while any explicit requirement above lacks evidence.
The existing Mac installed-app isolation gate remains separate; select and state
the supported client platform for the first installed assistant proof.

## Evidence (2026-09-10)

- Public independent app: `techartdev/ShellCanvas-Assistant`, version 0.1.2,
  source `44c61c1`. Fresh clone: `npm ci`, all 11 tests, build and repository
  packaging passed with a clean resulting worktree. No desktop-source imports.
- Native Windows Apps UI installed 0.1.0, reviewed 0.1.1 and 0.1.2 updates, and
  retained an existing 0.1.0 window until closed. Changed permissions affected
  newly opened windows. Verified denied network before opening the credential
  dialog and explicit session-only history without storage grants; restored all
  approved grants afterward.
- Real Terra Responses rounds: workspace discovery in local mode, text/image
  attachments (fixture word and color correctly identified), remote file
  selection, discovery/list/read/reviewed edit and reviewed console exchange.
  Independent SSH readback verified edited bytes and absence of declined/canceled
  files. Only generated temporary host fixtures were modified.
- Native clipboard text/image previews and persisted draft attachments passed.
  Conversation copy/reload passed. Compact 700 x 620 and normal desktop layouts
  were inspected. Stop during approval left no pending review and the next
  message succeeded. Manual disconnect is busy-guarded; after Stop, reconnect
  preserved chat and required accepting the new binding. Mid-approval binding
  changes and stale revisions are deterministic tool tests, not a simulated
  claim of live network failure.
- Core frontend: 271 tests / 48 files. SDK packaging/schema: four tests.
  `npm run verify:sdk` consumed a packed SDK in fresh outside projects.
  `cargo test --workspace --lib` and the production frontend build passed.
  Native HTTP tests use generated fixture credentials, not the user's key.
- Strict all-target Clippy and Rust formatting passed. The final embedded-assets
  Windows debug build succeeded. After restart, version 0.1.2, the selected Terra
  model, the saved endpoint/key-presence metadata and an earlier image conversation
  were restored. Reopened the normal desktop without the temporary CDP flag.
- Generated remote fixtures were removed after independent byte/absence checks.

## Where this milestone stops

The first installed-app target is Windows. Other desktop/mobile isolation,
signed installers, provider-specific OAuth, automatic context compaction,
unattended background work, multi-host agent runs and WispCrew runtime reuse are
follow-ups, not hidden prerequisites. The assistant uses optional services and
does not add device-specific execution shortcuts. See the post-goal backlog for
future work; the original base API milestone remains closed.
