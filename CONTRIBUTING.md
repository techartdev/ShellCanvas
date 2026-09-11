# Contributing to ShellCanvas

Thanks for helping. ShellCanvas is a public preview, so small, focused contributions and reports from real systems are the most valuable right now while the interfaces settle.

## Ways to help

- **Report a bug.** Open an issue with the ShellCanvas version, your Windows or macOS version, the remote system (for example `uname -sr` and the SSH server), what you did, what you expected and what happened.
- **Report compatibility.** A short note that a given server, distribution or device works, partly works or fails is useful evidence. Say which features you tried.
- **Improve the code or docs.** Pick an item from the [backlog](BACKLOG.md) or the [current handoff](docs/post-goal-backlog.md), or fix something you ran into.
- **Build something.** Apps, themes and connection adapters live outside this repository and need no desktop fork. See [Building on ShellCanvas](#building-on-shellcanvas).

Security problems are different: report them privately as described in the [security policy](SECURITY.md), not in public issues.

## Keep private data out

Before you post an issue, a screenshot, a log or a commit, remove credentials, private keys, real host names and addresses, terminal transcripts and remote file contents. Use sample data instead; the browser preview (`npm run dev`) shows synthetic hosts and files that are safe to publish.

## Set up

1. Install Node.js 22+, Rust 1.93+ and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.
2. Install dependencies and start the desktop:

   ```sh
   npm ci
   npm run desktop
   ```

3. For visual work without a server, run `npm run dev` and open the preview at `http://127.0.0.1:1420`. It uses labeled sample data, cannot connect over SSH and never falls back to sample data after a failed native connection.

## Before you open a pull request

- Run `npm run verify`. It checks formatting, builds and tests the frontend, runs the locked Rust tests and Clippy, and writes a local report. Use `npm run verify -- --native` to also build the desktop for your platform. The [verification guide](docs/verification.md) explains reports, failures and the manual checks that remain.
- Keep each pull request to one change, and describe what you verified and how.
- Update the backlog when your change completes or advances an item. Keep original IDs, and check an item only after it is implemented and validated within its stated scope.
- Say which evidence you have: unit tests, browser preview, native build, a manual walkthrough or a live host. Never mark a platform as supported from a fixture or the browser preview alone.
- Tests against a real SSH host need its owner's permission. Keep automated integration checks read-only unless a disposable directory is explicitly set aside for them.

## Building on ShellCanvas

- **An installable app.** Use the [app SDK](docs/app-sdk.md). It generates a separate project and builds a runtime package, with no desktop rebuild. Declare the permissions you need, use service discovery, handle a lost capability gracefully, keep drafts through a reconnect, and use the shared system dialogs and window state APIs.
- **A bundled app.** Trusted source modules inside this repository follow the [bundled app guide](docs/apps.md). This workflow is different from isolated runtime packages.
- **A connection adapter.** The [Rust adapter SDK and CLI](docs/adapter-sdk.md) create, build and validate independent native adapters. Implement the standard or custom services your device supports, and never add protocol-specific branches to desktop apps.
- **A system provider.** Implement `SystemProvider` in the Rust core, add it to provider selection and test it against representative systems. Detect capabilities instead of assuming utilities, init systems, privileges or shell syntax, and reuse the SFTP filesystem provider where it works. Read the [provider contract and compatibility matrix](docs/providers.md) first; BASE-04 through BASE-06 describe the probe, service and path work behind it.
- **A theme.** Themes are data files, with no SDK or build step. Start from [Canvas Study](examples/themes/canvas-study) and the [theme guide](docs/themes.md).
- **With an AI coding agent.** The repository's [AI development skills](docs/ai-development-skills.md) cover apps, adapters and the package lifecycle.

The [documentation map](docs/README.md), [roadmap](ROADMAP.md) and [backlog](BACKLOG.md) describe priorities and completion gates.

## License

Contributions to MPL-covered files are made under the [Mozilla Public License 2.0](LICENSE). Add `SPDX-License-Identifier: MPL-2.0` to new source files. You keep your copyright; no copyright assignment or relicensing is assumed. Introducing a dependency or code under different terms needs an explicit license-compatibility review first.

By taking part, you agree to follow the [code of conduct](CODE_OF_CONDUCT.md).
