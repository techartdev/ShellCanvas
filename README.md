# ShellCanvas

A desktop canvas for remote devices. Built with **Tauri 2, Rust, and TypeScript/React**. The current SSH connector uses the remote machine's existing SSH server; file browsing additionally needs SFTP. No ShellCanvas agent is installed remotely.

This is an early working prototype, not a complete file manager or a hardened public release.

The architecture is evolving toward a connection-neutral desktop: SSH is the first/default adapter, and future workspaces can combine file access, a console and device APIs from different adapters. See [the composition design](docs/connections.md). Serial, Telnet, FTP and API adapters are not implemented yet.

## Run

Development prerequisites: Node.js 22+, Rust 1.93+, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci
npm run desktop
```

`npm run dev` opens the **browser design preview** at `http://127.0.0.1:1420`. It uses explicitly labeled synthetic data. It cannot make SSH connections, and failed native connections never fall back to sample data.

Build an executable with embedded frontend assets:

```sh
npm run tauri -- build --debug --no-bundle
```

Windows output: `target/debug/shellcanvas.exe`. This debug build is for local evaluation. Installers, signing, release optimization, and macOS/Linux/mobile packaging are not validated yet. Windows requires the WebView2 runtime, but end users do not need Node or Rust for a packaged build.

## Included

- A custom desktop shell with mountain wallpapers, a dock, launcher, local clock, and floating app windows.
- Persistent settings for desktop appearance/clock/motion, terminal text/cursor/history, editor text/wrap/indentation, and Files visibility/order/density. The Hosts section opens saved connection settings. [Settings behavior and limits](docs/settings.md).
- Provider-defined remote settings in Host details: static hostname and timezone on supported Linux/systemd hosts, review before apply, read-only reasons, revision checks and verified readback. [Remote settings and validation limits](docs/remote-settings.md).
- Move, resize, maximize, minimize, and reopen windows across the full desktop between the top toolbar and bottom dock. Windows can cover desktop widgets, which remain clickable when uncovered. Narrow displays use stacked layouts.
- Real SSH connections with private-key/passphrase or password authentication.
- Multiple simultaneous host workspaces. Use the host pill in the top bar to switch; each workspace keeps its Files navigation, terminal buffer and window layout. Add host opens another connection; Disconnect releases the selected connection and retains its windows/drafts. Close workspace removes that workspace with an unsaved-work guard.
- Cancel pending connections and reconnect a lost host in its existing workspace, preserving folders, windows and editor drafts. Reconnection opens fresh shells. [Recovery behavior and limits](docs/connection-recovery.md).
- Strict verification against the user's `~/.ssh/known_hosts` and ShellCanvas's own trust store. New hosts require explicit fingerprint review; changed/revoked keys remain blocked before authentication. No automatic trust enrollment or security downgrade.
- Import of basic, explicit `Host` blocks from `~/.ssh/config`. Select the profile and supply any missing username.
- Save, edit and remove named host profiles in the native connection dialog. Saved entries live in the application data directory, independently of SSH config; passwords and passphrases are excluded. Use **Save host** before connecting if you want to keep an entry.
- An xterm.js terminal with binary output streaming, input, PTY resize, and independent SSH channels.
- Terminal right-click menu: Copy, Paste, Select all, Clear scrollback and New shell. Ctrl+Shift+C/V (or Cmd+C/V on macOS) handles clipboard actions; Ctrl+C remains the remote interrupt. Shift+F10 opens the menu. The terminal viewport stays contained above its footer while resizing.
- SFTP directory browsing, filtering, parent/back navigation, UTF-8 previews, new folders, rename, **Move to folder…** with destination browsing and no replacement, and confirmed deletion of files/links/empty folders. [File-action behavior and limits](docs/file-actions.md).
- Native upload/download dialogs, **Copy to folder…** for regular remote files, per-window transfer queues, bounded streaming, progress and cancellation. Existing destinations are preserved. [Transfer behavior and limits](docs/transfers.md).
- A remote text editor with independent windows, undo/redo, find, word wrap, clipboard actions and saving existing UTF-8 files up to 256 KiB. Open editors follow workspace file/folder renames and moves while keeping drafts. Atomic SFTP replacement and revision checks detect conflicts; unsupported servers keep preview/draft access. [Save behavior and limits](docs/text-editor.md).
- Files context menus for open/preview, open folder in a new window, copy name/path/text, navigation and clipboard-path access. Shift+F10 opens menus; Ctrl+C copies a selected path, Ctrl+L focuses the path field, F5 refreshes, and Alt+Left/Up navigates. A folder-actions button provides pointer/touch access.
- Cut (Ctrl+X) and Paste here (Ctrl+V) move an item between Files windows in the same workspace. A shared banner shows the pending item; Escape cancels the cut. Existing destinations are never replaced. [File clipboard behavior](docs/file-clipboard.md).
- Files windows, Back history and previews follow confirmed workspace renames/moves. Background refresh preserves filters and typed addresses; stale responses cannot restore old locations. [Navigation behavior](docs/file-navigation.md).
- Multiple Files and Terminal instances per workspace, with numbered titles, independent buffers/navigation and close/minimize behavior. The titlebar plus button creates another instance; the dock context menu lists existing windows. Desktop and titlebar context menus provide common window actions.
- Linux detection behind a system-provider interface; generic SSH fallback when no provider matches.
- A bundled app registry with local/host scope and required/optional capabilities. App service handles reject undeclared calls and keep transfer tickets scoped to their app. [Service declarations](docs/app-services.md).
- Versioned bundled app manifests, generic window layouts, per-app render failure recovery, and a Host details reference app. Minimize preserves an app; close releases it (closing Terminal ends its shell).
- Unavailable apps cannot be newly launched. Existing windows remain accessible after capability loss so local drafts can be recovered. Limited devices retain their supported tools; independent command probing is optional and device detection has a total time budget.

## Current boundaries

Files and Editor now consume [provider-owned navigation metadata](docs/filesystem-contract.md), including opaque paths and multiple roots. The production adapter still uses POSIX SFTP conventions; other path models are verified through synthetic providers.

- Files and Terminal support multiple instances; other apps opt in through their manifest. Workspace state survives switching during this app run; it is not restored after closing the workspace or restarting the app. Reconnecting starts a new session and shell; it does not restore remote processes.
- Transfers support regular files; directory transfer, resume and overwrite are not implemented. Files can move items and copy regular files within the current host's file service; recursive deletion, directory copy, remote Copy/Paste and cross-host operations remain pending. **The terminal is a real shell with all permissions of the authenticated account**, including root when selected.
- Editor drafts survive workspace switches and connection loss. Deliberate window/workspace/app closure guards unsaved work; forced termination can still lose in-memory drafts. Save As supports new names and explicit replacement review with revision checks. Crash recovery is not implemented yet.
- Passwords and key passphrases are not persisted. Key files remain in their existing location. Named SSH profiles are stored as versioned `hosts.json` in Tauri's app data directory (Windows: `%APPDATA%/dev.shellcanvas.client`), with atomic replacement and a cross-process lock. Unrecognized/corrupt files are reported and preserved. Secure credential-vault integration remains future work. Non-secret desktop/app preferences use versioned local WebView storage; they are separate from host profiles and editor drafts.
- The importer is not a full OpenSSH configuration interpreter: `Include`, `Match`, wildcard defaults, `ProxyCommand`, `ProxyJump`, SSH agents, hardware keys, and host certificates are unsupported. Imported fields are editable before connecting.
- Host-key checks support ordinary/hashed entries, wildcard and negated patterns, ports, aliases and revocation. Unrelated markers do not block known hosts; certificate verification remains unsupported. Malformed trust files fail closed. [SSH trust behavior and limits](docs/ssh-host-trust.md).
- Connection loss is detected through SSH transport closure and keepalives; it can take roughly a minute to recognize an unreachable network peer.
- Extensions are trusted, bundled source modules. There is no runtime plugin loader, marketplace, or third-party sandbox yet. Do not load untrusted JavaScript into the native webview.
- Tablet/phone layouts are browser-checked. Native Android/iOS builds and touch-keyboard behavior are not yet validated.

## Verify

```sh
npm run verify
npm run verify -- --native
```

The second command also builds the current platform's debug executable. Both stop on failure and write a local report; neither launches UI walkthroughs or remote probes. See [verification scope and release checklist](docs/verification.md).

For an explicitly authorized host already present in `known_hosts`:

```sh
cargo run -p shellcanvas-core --example probe -- HOST USER KEY_PATH
```

The probe checks authentication, Linux detection, home-directory SFTP listing, `/etc/os-release` text preview, PTY negotiation, shell input/output, terminal dimensions, and disconnect. It does not print remote file contents or credentials. Its shell command unsets `HISTFILE` before printing a marker, checking `stty size`, and exiting. Normal server authentication/audit activity can still occur.

## Architecture and contribution

Start with [the roadmap](ROADMAP.md) and [development backlog](BACKLOG.md). See [the architecture](docs/architecture.md), [app guide](docs/apps.md), [remote support matrix](docs/providers.md), [WispCrew AI integration assessment](docs/ai-integration.md), and [contribution guide](CONTRIBUTING.md). The public SDK remains provisional. Commercial packaging is intentionally undecided.

## License

[MPL-2.0](LICENSE). Distributed modifications to covered files remain under MPL. Separate extensions may use other licenses, including proprietary licenses, subject to their dependencies and the MPL's requirements. No contributor relicensing or copyright assignment is assumed.
