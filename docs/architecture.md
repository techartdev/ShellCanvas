# Architecture

The target architecture is a composable remote-device desktop. SSH is the first connector, not a mandatory superclass for all future access. A workspace may bind Files to FTP, Terminal to serial/Telnet, and device operations to an API. Apps consume services through a workspace broker. [Connection and service composition](connections.md) defines the accepted direction, partial-failure rules and incremental migration. The diagram below describes the current SSH implementation, not the full target.

## Boundaries

```text
Desktop shell (React / TypeScript)
  ├─ bundled apps: Files, Terminal, Host details
  ├─ app registry: identity, scope, capabilities, component
  └─ HostServices interface
         ├─ Browser preview: synthetic data only
         └─ Tauri IPC
               ├─ session lifecycle and stale-session rejection
               ├─ Linux / generic system inspection
               ├─ SFTP filesystem provider
               └─ Rust SSH connection and terminal channels
```

The UI never builds shell commands. Linux detection executes a small fixed set of read-only commands through separate channels. SFTP operations use the protocol rather than parsing `ls`. Host keys are checked before authentication. Raw credentials are confined to the connect request and the native authentication code; public profile objects contain key paths, not key contents.

## Desktop apps

`src/sdk.ts` defines `DesktopApp`, `AppContext`, and `HostServices`. `src/apps/registry.ts` registers the bundled apps. The shell renders windows and dock entries from that registry. Local apps can declare no SSH requirements; a calendar or calculator would not need a host session.

`defineApps` checks the bundled API version, unique IDs, scope, requirements and layout. Manifests control startup and window layout; unconfigured apps use a standard frame. `src/desktop.ts` manages open/minimized state and full stacking order. Close unmounts an app and releases its resources; minimize preserves it. A per-app React error boundary contains render/lifecycle failures. This does not catch async/event errors or isolate malicious code. See [the app guide](apps.md).

An app declares capabilities such as `files.read` or `terminal`. A missing capability produces an explicit unavailable state. The registry is a development extension point, **not a security sandbox**. Bundled code shares a trusted webview and can call application commands.

Future external extensions need an isolated execution surface, permission-enforcing native APIs, lifecycle management, resource limits, and SDK version negotiation. They must not receive passwords or private keys. Public SDK stability and a plugin marketplace come after that work.

## Remote-system providers

`crates/ssh-core/src/provider.rs` separates `SystemProvider` from `FileSystemProvider`. Linux is the first system provider; SFTP is reusable across systems. A future Windows provider should detect its supported command environment, handle its system operations and path conventions, and report capabilities without adding Windows checks to React components.

Provider selection accepts an ordered provider list and a total time budget. `ProbeContext` supplies optional independent command access through `CommandProbe`; Linux detection no longer takes a concrete SSH connection. A connector without exec keeps its fallback information and capabilities. The current SSH entry point supplies LinuxProvider, while fixture tests cover limited/no-command access. This is the first interface seam, not yet a full connection adapter registry.

Next come generic service handles, composite workspace bindings, per-service capability states, scoped app services and provider-owned filesystem navigation. See [provider requirements and actual compatibility](providers.md). macOS, Windows, Raspberry Pi OS, appliances and additional connection protocols are roadmap targets, not verified support claims.

## Lifecycle

- Session IDs prevent commands from accidentally acting on a replacement host.
- A transition lock serializes connect/disconnect/terminal creation.
- File operations clone their provider under a short lock, then run independently of the terminal.
- Each terminal owns a channel and bounded input queue. Closing the app process drops the connection; minimizing a window keeps its shell alive. Closing the Terminal window cleans up that channel.
- New-shell actions explicitly close the old channel. Remote processes may end when their shell closes; no `tmux` dependency or remote installation is introduced.
- Incoming terminal bytes remain bytes until xterm.js processes them. This avoids corrupting multibyte characters split across SSH packets.
- Reconnect failures stay visible and never substitute preview data.

## Future deployment

AI is an optional app behind a replaceable assistant service and a session-bound host tool broker. [The WispCrew source assessment](ai-integration.md) records reusable logic and Node/runtime constraints; no AI code or mandatory sidecar is included yet.

The Rust core has no Tauri dependency. A future web gateway can reuse it behind a separately authenticated service boundary. An ordinary cross-browser frontend needs such a gateway to reach SSH. Hosted credential handling, gateway authorization, private-network access, and commercial policy are separate decisions.

## Initial validation

The first integration probe succeeded against the user-authorized Linux test host on 2026-09-08: known-host verification, key authentication, Linux detection, SFTP listing and UTF-8 preview, PTY allocation, shell input/output, 120 × 40 resize, and disconnect. Host addresses and private credentials are intentionally absent from the repository.

That probe validates the Rust transport/provider path. It does not by itself validate every native UI workflow, other SSH servers, password authentication, other client operating systems, or mobile builds.
