# ShellCanvas system API and runtime extensions

Objective: provide a small, coherent virtual-desktop API for bundled and community apps, with reusable system UI and runtime-loadable apps, device providers and connection adapters. Adding an extension must not require rebuilding the desktop. This document tracks the full objective, not just the first implementation slice.

## Delivery and evidence gates

| Area                       | Required behavior                                                                                                                                      | Completion evidence                                                                                                    | Status      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------- |
| System UI                  | Promise-based message boxes, Open and Save pickers, consistent keyboard/focus behavior, per-window cancellation and session isolation                  | Bundled app adoption, lifecycle tests, desktop/tablet walkthrough                                                      | In progress |
| App system services        | Versioned API for app/window lifecycle, settings/storage, clipboard, events and service discovery; structured errors and cancellation                  | Independent sample app using only the public SDK; contract tests                                                       | Pending     |
| Runtime apps               | Install, validate, activate, update, disable and remove packages while the desktop runs; preserve unsaved work and reject stale calls                  | Load a separately built app without rebuilding/restarting core; update and unload walkthrough                          | Pending     |
| Extension boundary         | Package identity, declared access, isolated external UI, enforced broker, revocation and resource cleanup                                              | Negative fixtures for direct IPC, undeclared calls, foreign handles, late replies and teardown                         | Pending     |
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

The [runtime app workbench](runtime-apps.md) now loads an independently bundled package into an opaque-origin iframe and brokers shared dialogs over an instance-owned JSON channel. This is development-only evidence for the runtime apps, extension boundary and developer-experience rows; those rows are not complete. Production package management, native isolation checks, update state preservation, the rest of the system services, adapter packages and AI skills remain pending. No production CSP relaxation has been made.
