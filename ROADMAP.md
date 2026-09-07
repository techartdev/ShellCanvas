# Product roadmap

Product name: **ShellCanvas**. Monetization and public launch dates remain open. The initial source repository is private while the foundation develops.

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

| Milestone                | Outcome and completion gate                                                                                                                       | State                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| M0 — Working desktop     | Real Linux SSH/SFTP/PTY, usable Files and Terminal, correct desktop work area                                                                     | Prototype demonstrated on Windows against one Linux host |
| M1 — Extensible base     | Versioned bundled app manifests, app lifecycle and failure containment; testable provider selection; session-bound app APIs; contributor examples | In progress: app lifecycle slice implemented             |
| M2 — Everyday workspace  | Saved non-secret profiles, trust enrollment, multiple terminal instances, resilient transfers and safe file writes                                | Planned; builds on M1                                    |
| M3 — Provider proof      | Linux and Raspberry Pi OS, macOS, Windows OpenSSH, then one non-POSIX appliance; common desktop works without OS branches in apps                 | Planned; each target has an independent test gate        |
| M4 — External extensions | Versioned installable packages, isolated UI and native permission enforcement, lifecycle limits, upgrade/uninstall and documented SDK             | Planned; required before loading untrusted extensions    |
| M5 — Optional assistant  | WispCrew reuse spike followed by host-bound chat, streaming, cancel, approvals and bounded tool execution                                         | Planned; architectural spike may run after M1            |
| M6 — Wider distribution  | Validated Windows/macOS/Linux packages, tablet-native proof, accessibility and release documentation                                              | Planned; mobile/web delivery evaluated separately        |

M3 can progress alongside M2 when representative hosts are available. The provider contract should be proven against a second system before freezing an SDK. Start the AI design early, but do not make a Node runtime, daemon, model account, or remote installation a prerequisite for Files and Terminal.

## Current implementation slice

The first M1 slice removes hardcoded app startup and window layouts from the shell. Manifests choose startup and layout; a generic window lifecycle tracks focus, minimize and close; render failures stay in the affected app. Host details demonstrates a third app with the generic frame and existing provider data. The next slice introduces a transport-independent probe context, a total detection budget, and disabled launchers for missing capabilities. The live connection implementation remains SSH/SFTP.

This is **not** the external plugin runtime, a completed provider SDK, new remote OS support, or a working AI integration.

## Working process

[BACKLOG.md](BACKLOG.md) is the single task list. Each item has an ID, dependencies and an observable completion gate. Check an item only after implementation and appropriate validation; distinguish fixtures, browser previews, native builds, and live-host results. Update this roadmap when scope changes, and update the backlog after each development slice.

Next implementation sequence: finish **BASE-04 provider test seam**, then **BASE-08 service contracts**, **BASE-09 composite bindings**, and **BASE-05 scoped app services**. A mixed-adapter fixture must prove partial failure and resource ownership before implementing a second real connection adapter. See [the architecture](docs/architecture.md), [app guide](docs/apps.md), [provider matrix](docs/providers.md), and [AI integration notes](docs/ai-integration.md).
