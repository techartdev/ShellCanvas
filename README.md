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
- Move, resize, maximize, minimize, and reopen windows across the full desktop between the top toolbar and bottom dock. Windows can cover desktop widgets, which remain clickable when uncovered. Narrow displays use stacked layouts.
- Real SSH connections with private-key/passphrase or password authentication.
- Strict verification against the user's existing `~/.ssh/known_hosts`. Unknown and changed keys are refused. No automatic trust enrollment or security downgrade.
- Import of basic, explicit `Host` blocks from `~/.ssh/config`. Select the profile and supply any missing username.
- An xterm.js terminal with binary output streaming, input, PTY resize, and independent SSH channels.
- Read-only SFTP directory browsing, filtering, parent/back navigation, and UTF-8 file previews up to 256 KiB.
- Linux detection behind a system-provider interface; generic SSH fallback when no provider matches.
- A bundled app registry with local/host scope and capability requirements. No calculator is included.
- Versioned bundled app manifests, generic window layouts, per-app render failure recovery, and a Host details reference app. Minimize preserves an app; close releases it (closing Terminal ends its shell).
- Unavailable apps are disabled in the launcher and dock with an explanation. Limited devices retain their supported tools; independent command probing is optional and device detection has a total time budget.

## Current boundaries

- One connected host workspace and one terminal app at a time. Reconnecting starts a new shell; it does not restore remote processes.
- The file explorer does not yet upload, download, edit, rename, or delete files. **The terminal is a real shell with all permissions of the authenticated account**, including root when selected.
- Passwords and key passphrases are not persisted. Key files remain in their existing location. Secure credential-vault integration and saved app-specific profiles are future work. Wallpaper preference alone is stored in local storage.
- The importer is not a full OpenSSH configuration interpreter: `Include`, `Match`, wildcard defaults, `ProxyCommand`, `ProxyJump`, SSH agents, hardware keys, and host certificates are unsupported. Imported fields are editable before connecting.
- `known_hosts` files with `@cert-authority` or `@revoked` markers are refused rather than partially interpreted. Ordinary and hashed host entries are handled by russh. Use the exact hostname/IP under which the key is recorded.
- Connection loss is detected through SSH transport closure and keepalives; it can take roughly a minute to recognize an unreachable network peer.
- Extensions are trusted, bundled source modules. There is no runtime plugin loader, marketplace, or third-party sandbox yet. Do not load untrusted JavaScript into the native webview.
- Tablet/phone layouts are browser-checked. Native Android/iOS builds and touch-keyboard behavior are not yet validated.

## Verify

```sh
npm run build
npm test
cargo test --workspace
```

For an explicitly authorized host already present in `known_hosts`:

```sh
cargo run -p shellcanvas-core --example probe -- HOST USER KEY_PATH
```

The probe checks authentication, Linux detection, home-directory SFTP listing, `/etc/os-release` text preview, PTY negotiation, shell input/output, terminal dimensions, and disconnect. It does not print remote file contents or credentials. Its shell command unsets `HISTFILE` before printing a marker, checking `stty size`, and exiting. Normal server authentication/audit activity can still occur.

## Architecture and contribution

Start with [the roadmap](ROADMAP.md) and [development backlog](BACKLOG.md). See [the architecture](docs/architecture.md), [app guide](docs/apps.md), [remote support matrix](docs/providers.md), [WispCrew AI integration assessment](docs/ai-integration.md), and [contribution guide](CONTRIBUTING.md). The public SDK remains provisional. Commercial packaging is intentionally undecided.

## License

[MPL-2.0](LICENSE). Distributed modifications to covered files remain under MPL. Separate extensions may use other licenses, including proprietary licenses, subject to their dependencies and the MPL's requirements. No contributor relicensing or copyright assignment is assumed.
