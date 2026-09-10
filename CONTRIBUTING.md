# Contributing

ShellCanvas is at the prototype stage. Small, focused contributions and compatibility reports will be most useful while the interfaces settle.

Use [the documentation map](docs/README.md), [roadmap](ROADMAP.md) and [backlog](BACKLOG.md) for priorities and completion gates. Keep the backlog current with implementation and validation; do not mark an entire platform supported from a fixture or browser preview alone. Security reports follow [the private reporting policy](SECURITY.md), not the public issue tracker.

## Development

1. Install the prerequisites in the README.
2. Run `npm ci` and `npm run desktop`.
3. Run `npm run verify` before submitting a change; use `npm run verify -- --native` for a desktop build. See the [verification guide](docs/verification.md) for reports, failure handling and manual gates.
4. Keep credentials, host addresses, terminal transcripts, and remote files out of commits and screenshots intended for publication.

Use `npm run dev` for visual work with synthetic data. Tests against a real SSH host require its owner's authorization. Keep automated integration checks read-only unless a disposable fixture directory is explicitly designated.

## Adding an app

For an installable community app, use the [public app SDK](docs/app-sdk.md).
It generates a separate project and builds a runtime package; no desktop rebuild
is needed. Declare permissions, use service discovery, handle capability loss and keep
drafts during reconnect. Use the shared system dialogs and window state APIs.

For a trusted bundled module, follow [the app guide](docs/apps.md). That source
extension workflow is different from isolated runtime packages.

## Adding an adapter or using AI development tools

The [Rust adapter SDK and CLI](docs/adapter-sdk.md) generate, build and validate
independent native adapters. Implement supported standard or custom services;
do not add protocol-specific branches to desktop apps. See the
[AI development skills](docs/ai-development-skills.md) for repository-distributed
guidance on apps, adapters and package lifecycle.

## Adding a system provider

Implement `SystemProvider` in the Rust core, add it to provider selection, and test against representative systems. Detect capabilities; do not silently assume utilities, init systems, privileges, or shell syntax. Reuse the SFTP filesystem provider where supported.

See [the provider contract and compatibility matrix](docs/providers.md) before extending support. BASE-04 through BASE-06 track the necessary probe, service and path work.

## License

Contributions to MPL-covered files are made under MPL-2.0. Add `SPDX-License-Identifier: MPL-2.0` to new source files. Contributors retain their copyright. Introducing dependencies or code with different terms requires an explicit license-compatibility review.
