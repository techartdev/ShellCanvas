# Product roadmap

Product name: **ShellCanvas**. Monetization and public launch dates remain open. The initial source repository is private while the foundation develops.

Updated 2026-09-10 after the Windows base API goal and the Mac compatibility
follow-up. [Current unfinished work](docs/post-goal-backlog.md) separates native
validation, new features and decisions, with an observable gate for each item.

Build a beautiful desktop for remote devices, with a small dependable core and an approachable extension platform. SSH is the first and default connection method. A workspace can combine adapters: for example, FTP for files, serial or Telnet for a console, and an API for device operations. Use existing device interfaces without requiring a product-specific remote daemon. See [connection and service composition](docs/connections.md).

## Product commitments

- Desktop quality is part of each feature's acceptance: spacing, focus, loading, errors, keyboard use, and narrow layouts. Windows use the full space between the top toolbar and dock.
- Community developers can add desktop apps and remote-device providers without rewriting the shell. Ship trusted source extensions first; installed third-party code requires a real isolation boundary.
- Connection adapters are a third extension point. Compose service bindings per workspace; do not require every adapter to emulate SSH, a shell, a filesystem or a byte stream. Unsupported functions are disabled with reasons, while independently supported functions remain usable.
- Remote support grows through tested providers. Linux VPS, Raspberry Pi OS, macOS, Windows OpenSSH, and network appliances are distinct compatibility targets. Raspberry Pi is hardware: select capabilities from its installed OS rather than its name.
- Terminal and files remain useful without AI. AI is an optional desktop app, using the same host and permission boundaries as other tools.
- Keep Tauri 2, Rust, TypeScript/React, and the independent Rust SSH core. Preserve MPL-2.0 for the core; commercial offerings are undecided.
- Support claims come from repeatable tests, not competitor feature counts or inferred market demand.

## Delivery sequence

| Milestone                | Outcome and completion gate                                                                                                                       | State                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| M0 — Working desktop     | Real Linux SSH/SFTP/PTY, usable Files and Terminal, correct desktop work area                                                                     | Prototype demonstrated on Windows against one Linux host                       |
| M1 — Extensible base     | Versioned bundled app manifests, app lifecycle and failure containment; testable provider selection; session-bound app APIs; contributor examples | Complete within Windows BASE-11 scope                                          |
| M2 — Everyday workspace  | Saved non-secret profiles, trust enrollment, multiple terminal instances, resilient transfers and safe file writes                                | Core flows delivered; native/failure checks and refinements remain             |
| M3 — Provider proof      | Linux and Raspberry Pi OS, macOS, Windows OpenSSH, then one non-POSIX appliance; common desktop works without OS branches in apps                 | Linux live evidence; Mac browsing/shell confirmed; broader coverage open       |
| M4 — External extensions | Versioned installable packages, isolated UI and native permission enforcement, lifecycle limits, upgrade/uninstall and documented SDK             | Windows runtime/SDK delivered; other native platforms gated                    |
| M5 — Optional assistant  | WispCrew reuse spike followed by host-bound chat, streaming, cancel, approvals and bounded tool execution                                         | Planned; architectural spike may run after M1                                  |
| M6 — Wider distribution  | Validated Windows/macOS/Linux packages, tablet-native proof, accessibility and release documentation                                              | Windows/Mac debug builds; Mac layout/Settings confirmed; release packages open |

M3 can progress alongside M2 when representative hosts are available. SDK contracts
remain provisional; actual device compatibility requires its own evidence.
WispCrew reuse was assessed, but assistant integration remains deferred. Do not
make a Node runtime, daemon, model account or remote installation a prerequisite
for Files and Terminal.

## Current handoff

The bounded Windows API goal is complete. Runtime apps/adapters, mixed-source
workspaces, shared services and independently built SDK examples passed the
[acceptance audit](docs/kernel-acceptance.md). Folder transfer discovery is
incremental; the former tree-entry/depth caps are removed. These capabilities do
not establish production Serial/Telnet/FTP/device API support.

The subsequent native Catalina startup, geometry, spacing and modal-dialog fixes
passed focused WebKit checks, and the user confirmed desktop layout and Settings.
Mac SSH/clipboard acceptance, Linux native rollout, non-Windows adapter descendant
cleanup and extension isolation remain open. See [Mac validation](docs/macos-validation.md).

Next work should close a selected real-world reliability or platform gap, rather
than expand the base API. The [post-goal backlog](docs/post-goal-backlog.md) records
network interruption, native workflow checks, advanced clipboard/recovery features,
device adapters, AI, distribution and decisions without starting them all.

## Working process

[BACKLOG.md](BACKLOG.md) is the task entry point; its
[post-goal handoff](docs/post-goal-backlog.md) is the consolidated current remaining
list. Preserve original IDs when returning to an older task. Check an item only
after implementation and appropriate validation; distinguish fixtures, browser
previews, native builds, user confirmation and live-host results. Update the
handoff after each completed slice.

The [earlier core goal record](docs/core-completion.md) and
[kernel history](docs/kernel-history.md) retain historical checkpoints. Their
old pending statements do not reopen capabilities completed in BASE-11. The
fixed [API boundary and stopping rule](docs/kernel-roadmap.md#base-api-boundary-and-stopping-rule)
remain in force.
