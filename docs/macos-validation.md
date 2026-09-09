# Intel Mac validation

Validation performed on 2026-09-09 using a physical MacBook Air (13-inch,
Mid 2012), Intel x86_64, 4 GB RAM, macOS Catalina 10.15.8 (19H2036).
This is a machine-specific record, not a declaration of general macOS support.

## Source and toolchain

The tested code is commit `ddbb580498a19c1a3bbc505ca24b4f7ac8afe27f`.
GitHub authentication was not configured on the Mac, so its checkout was cloned
from a Git bundle exported from the Windows checkout. The bundle's SHA-256 was
verified on both machines:
`fa5077e87b3f16185185399e3b7b7ac7f361620347dc265ee89f0b3cf092c206`.
The remote origin was then set to the private GitHub repository.

The Mac had Rust/Cargo 1.95.0 and Command Line Tools with the macOS 10.15.6 SDK.
Node 20.20.2 and npm 10.8.2 were installed in a separate user-owned build-tools
directory. The official Node archive checksum was verified. This legacy-machine
test does not change the project's documented Node baseline.

## Unmodified build

`npm ci --no-audit --no-fund` completed successfully, including the app SDK build.
The frontend production build also passed (1,681 modules).

The native build used:

```sh
export CARGO_BUILD_JOBS=2
export CARGO_PROFILE_DEV_DEBUG=0
export CARGO_INCREMENTAL=0
npm run tauri -- build --debug --no-bundle
```

Compilation and linking succeeded in 30 minutes 19 seconds, producing
`target/debug/shellcanvas`, identified as a Mach-O 64-bit x86_64 executable.
No source or lockfile content changed. npm set the executable bit on
`packages/app-sdk/bin/shellcanvas-app.mjs` in the Mac checkout.

The executable aborted at startup before rendering the desktop:

```text
failed overriding protocol method -[WKNavigationDelegate webView:navigationAction:didBecomeDownload:]: method not found
```

The failure is in objc2 0.6.4's debug protocol-method validation and matches
[Tauri issue 15431](https://github.com/tauri-apps/tauri/issues/15431).
The original build and launch logs are retained under
`/Users/user/ShellCanvas/.local/mac-validation/` on the test Mac.

## Compatibility experiment

A second build used only objc2's debug assertions disabled:

```sh
npm run tauri -- build --debug --no-bundle -- --locked \
  --config 'profile.dev.package.objc2.debug-assertions=false'
```

This command-line override does not change the normal project profile. It is a
diagnostic experiment, not a verified fix or a release build. Compilation passed
in 8 minutes 51 seconds. The executable then stayed alive and opened its native
window, but displayed only the background. Web Inspector, observed through
AnyDesk, reported `SyntaxError: Unexpected token '='` before the desktop rendered.

The installed Safari application reports 15.6.1, while the system WebKit and
JavaScriptCore framework bundle versions both report `15609.4.1.1.1`. The frontend
currently targets ES2021. Determining the exact unsupported emitted expression,
setting an appropriate WebKit build target, and auditing runtime API availability
remain necessary; the installed Safari version alone is insufficient evidence of
embedded-webview compatibility.

**Outcome: the current source builds on this Mac, but the desktop is not usable
on this machine yet.** The debug workaround bypassed the original startup panic;
it did not establish a working Mac client. No application-source compatibility
patch or default build-profile change was made during this experiment.

## Remaining evidence

The user separately tested the Windows desktop client connected to this Mac over
SSH on 2026-09-09. Their screenshot shows the Mac's `/Users/user/MuAndroid`
directory in Files and its logged-in shell prompt in Terminal. This is evidence
of remote Mac file browsing and an established SSH console from Windows; it does
not validate a native Mac client, file writes, transfers, or clipboard behavior.

For the native Mac client, actual desktop rendering and interaction, SSH browsing/terminal operation,
clipboard interoperability, a distributable app bundle and signing remain to be
verified on this machine. Installed third-party UI frames are still gated on
macOS pending native isolation tests. Non-Windows adapter descendant cleanup is
also a separate open requirement; a successful desktop launch would not close it.
