# Roadmap

Where ShellCanvas is going, what is already in place and what comes next. Updated 2026-09-12. For the task-level list, see [BACKLOG.md](BACKLOG.md) and the [current handoff](docs/post-goal-backlog.md). No release dates are promised.

## Vision

A beautiful desktop for remote devices, built on a small, dependable core and an approachable extension platform.

SSH is the first and default connection. Over time a workspace can combine adapters, for example FTP for files, a serial or Telnet console, and an API for device operations, while every app keeps working through the same services. ShellCanvas uses the interfaces a device already has and never requires a product-specific remote daemon. See [connection and service composition](docs/connections.md).

## Principles

- **Desktop quality is part of every feature.** Spacing, focus, loading, errors, keyboard use and narrow layouts are acceptance criteria. Windows use the full space between the top bar and the dock.
- **Extensible without forks.** Community developers can add desktop apps and remote-device providers without rewriting the shell. Trusted source extensions came first; installed third-party code requires a real isolation boundary.
- **Connections compose.** Adapters are a third extension point. A workspace binds services per source, and no adapter has to emulate SSH, a shell, a filesystem or a byte stream. Unsupported functions are disabled with a reason while everything else stays usable.
- **Remote support grows through tested providers.** Linux servers, Raspberry Pi OS, macOS, Windows OpenSSH and network appliances are separate compatibility targets. A Raspberry Pi is hardware: capabilities come from its installed OS, not its name.
- **Useful without AI.** Terminal and Files never depend on an assistant. AI is an optional app with the same host and permission boundaries as any other tool.
- **A stable foundation.** Tauri 2, Rust, TypeScript and React, with an independent Rust SSH core. The core stays MPL-2.0; commercial offerings are undecided.
- **Claims follow evidence.** Support statements come from repeatable tests, not competitor feature lists or assumed demand.

## Where things stand

- **Public preview releases.** [0.1.0](https://github.com/techartdev/ShellCanvas/releases/tag/v0.1.0) and [0.1.1](https://github.com/techartdev/ShellCanvas/releases/tag/v0.1.1) ship Windows NSIS and MSI installers from a public MPL-2.0 repository. The installers are not code-signed yet.
- **SDKs in public registries.** `@techartdev/shellcanvas-app-sdk` on npm and `shellcanvas-adapter-sdk` and `shellcanvas-filesystem-sdk` on crates.io, all at a provisional 0.1.0.
- **Canvas Assistant** is a separate public app, installable from GitHub through App Manager.
- **[shellcanvas.com](https://shellcanvas.com)** hosts the website and user documentation.
- **Next release, already on `main`:** the app launcher, App Manager, the refreshed Canvas theme and folder transfers without the 0.1.0 item cap. See the [changelog](CHANGELOG.md).

## Milestones

| Milestone | Outcome and completion gate | State |
| --- | --- | --- |
| **M0 · Working desktop** | Real Linux SSH/SFTP/PTY, usable Files and Terminal, correct desktop work area | Done. Shipped in 0.1.0; live evidence against one Linux host |
| **M1 · Extensible base** | Versioned bundled app manifests, app lifecycle and failure containment, testable provider selection, session-bound app APIs, contributor examples | Complete within the Windows BASE-11 scope |
| **M2 · Everyday workspace** | Saved non-secret profiles, trust enrollment, multiple terminal instances, resilient transfers and safe file writes | Core flows delivered; native failure checks and refinements remain |
| **M3 · Provider proof** | Linux and Raspberry Pi OS, macOS, Windows OpenSSH, then one non-POSIX appliance; the common desktop works without OS branches in apps | Linux live evidence; Mac browsing and shell confirmed; broader coverage open |
| **M4 · External extensions** | Versioned installable packages, isolated UI and native permission enforcement, lifecycle limits, upgrade and uninstall, documented SDK | Windows runtime and SDKs delivered and published as provisional 0.1.0; other native platforms gated |
| **M5 · Optional assistant** | Independent installable chat app with streaming, cancel, selected context, approvals and bounded host tools | Delivered as Canvas Assistant; live model tests and public GitHub install and update verified on Windows |
| **M6 · Wider distribution** | Validated Windows, macOS and Linux packages, tablet-native proof, accessibility and release documentation | Unsigned Windows installers published; Mac debug builds with confirmed layout and Settings; signed and other-platform packages open |

M3 can move alongside M2 whenever representative hosts are available. SDK contracts stay provisional, and each device family needs its own evidence. The assistant uses its own app-side engine through the public SDK; a Node runtime, daemon, model account or remote installation must never become a prerequisite for Files and Terminal. Reuse of WispCrew was assessed, and runtime integration remains a possible follow-up.

## Next up

The base API is complete. Next work closes real-world reliability and platform gaps instead of widening the API.

- **Ship the next release** with the launcher, App Manager and refreshed theme.
- **Reliability in the field:** physical network interruption (POST-01), native Explorer paste walkthroughs (POST-02), two real devices at once (POST-03), a real remote-settings change on a disposable host (POST-04).
- **Platforms:** modern macOS and Apple Silicon (POST-06), the Linux client (POST-07), adapter child-process cleanup outside Windows (POST-08), and signed release packages (SHIP-02).
- **Trust and recovery:** managing trusted host keys (POST-20) and recovering unsaved drafts after a crash (POST-18).
- **Drive Bridge:** finish the remaining acceptance gates of the separate [Drive Bridge](https://github.com/techartdev/ShellCanvas-DriveBridge) app, including modern macFUSE. See [local drive bridge](docs/local-drive-bridge.md).
- **SDK policy:** compatibility, migrations and the support matrix for the published SDKs (POST-22).

## Later

- **More connections:** a serial console, Telnet, FTP file services and one structured device API (LINK-01 to LINK-04), each chosen from a real device need.
- **More remote systems:** Linux variants and Raspberry Pi OS (HOST-01), complete macOS support (HOST-02), Windows OpenSSH (HOST-03) and a first network appliance (HOST-04).
- **Richer clipboard:** cross-host copy, verified cross-device moves, multi-item Cut and native macOS and Linux file clipboards (CORE-05c).
- **Distribution:** publisher authentication, signing, rollback tooling and a possible marketplace (EXT-03).
- **Assistant polish:** longer conversations, cost visibility and provider presets (AI-04).
- **New form factors:** native tablets, then phones (SHIP-03), and an optional hosted web gateway that starts with a threat model (SHIP-04).

## Open decisions

Paid desktop, mobile, web or hosted offerings, private components and pricing are undecided (POST-24). The MPL-2.0 core and the public repository are settled. Launch timing and trademark checks are separate decisions.

## How we work

- [BACKLOG.md](BACKLOG.md) is the task entry point, and the [post-goal handoff](docs/post-goal-backlog.md) is the consolidated list of remaining work.
- Keep original IDs when returning to an older task.
- Check an item only after implementation and appropriate validation. Keep fixtures, browser previews, native builds, user confirmation and live-host results distinct.
- Update the handoff after each completed slice.
- The [earlier core goal record](docs/core-completion.md) and [kernel history](docs/kernel-history.md) keep historical checkpoints. Their old pending statements do not reopen capabilities completed in BASE-11.
- The fixed [API boundary and stopping rule](docs/kernel-roadmap.md#base-api-boundary-and-stopping-rule) remains in force.

Recent milestone records: the [standalone assistant](docs/assistant-goal.md), the [base API acceptance audit](docs/kernel-acceptance.md) and [Mac validation](docs/macos-validation.md).
