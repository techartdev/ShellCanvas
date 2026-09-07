# Contributing

ShellCanvas is at the prototype stage. Small, focused contributions and compatibility reports will be most useful while the interfaces settle.

Use [the roadmap](ROADMAP.md) for priorities and [the backlog](BACKLOG.md) for task IDs and completion gates. Keep the backlog current with implementation and validation; do not mark an entire platform supported from a fixture or browser preview alone.

## Development

1. Install the prerequisites in the README.
2. Run `npm ci` and `npm run desktop`.
3. Run `npm run build`, `npm test`, and `cargo test --workspace` before submitting a change.
4. Keep credentials, host addresses, terminal transcripts, and remote files out of commits and screenshots intended for publication.

Use `npm run dev` for visual work with synthetic data. Tests against a real SSH host require its owner's authorization. Keep automated integration checks read-only unless a disposable fixture directory is explicitly designated.

## Adding an app

Implement a component against `AppContext` and register its manifest in `src/apps/registry.ts`. Declare local/host scope and required capabilities. Handle loading, errors, disconnects, keyboard navigation, and narrow screens. Keep remote commands out of UI components.

Follow [the app guide](docs/apps.md). Host details is a minimal working reference. No shell edits are needed for a new app's startup, focus, dock entry or standard window. This is a trusted bundled API; the public extension runtime remains pending.

## Adding a system provider

Implement `SystemProvider` in the Rust core, add it to provider selection, and test against representative systems. Detect capabilities; do not silently assume utilities, init systems, privileges, or shell syntax. Reuse the SFTP filesystem provider where supported.

See [the provider contract and compatibility matrix](docs/providers.md) before extending support. BASE-04 through BASE-06 track the necessary probe, service and path work.

## License

Contributions to MPL-covered files are made under MPL-2.0. Add `SPDX-License-Identifier: MPL-2.0` to new source files. Contributors retain their copyright. Introducing dependencies or code with different terms requires an explicit license-compatibility review.
