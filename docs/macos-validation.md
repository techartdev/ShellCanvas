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
JavaScriptCore framework bundle versions both report `15609.4.1.1.1`. That frontend
targeted ES2021. Determining the exact unsupported emitted expression,
setting an appropriate WebKit build target, and auditing runtime API availability
remain necessary; the installed Safari version alone is insufficient evidence of
embedded-webview compatibility.

**Initial outcome: that source built on this Mac, but the desktop was not usable
on this machine.** The debug workaround bypassed the original startup panic;
it did not establish a working Mac client. No application-source compatibility
patch or default build-profile change was made during this experiment.

## Catalina bootstrap fix (2026-09-10)

The checkout was advanced to `40a8a234eb3723f20aa65c5230645e996f07109f`
and the compatibility changes accompanying this record were applied. The Mac's
existing executable-mode change was preserved in a Git stash before the update.

The system JavaScriptCore reproduced a syntax error for `??=`. The frontend now
targets Safari 13 syntax and loads selected core-js runtime compatibility modules
for `Array.at`, `Object.hasOwn`, and `structuredClone`. A UUID fallback uses the
platform's cryptographic random bytes and preserves native UUID generation when
available. A probe in the Mac's actual JavaScriptCore passed clone isolation,
cycles, typed arrays, array indexing, own-property checks, and UUID formatting.

The next native launch exposed xterm's module-level media-query subscription:
`TypeError: t.addEventListener is not a function`. Catalina provides the older
`addListener`/`removeListener` pair. A narrow compatibility bridge supplies the
plain change subscriptions used by the desktop and xterm. The desktop entry is
imported dynamically after compatibility setup, so terminal chunks cannot
evaluate before the bridge is installed. Startup failures also have a visible
text fallback instead of leaving an unexplained blank background.

Use `sh scripts/build-macos-legacy.sh` for this machine's debug evaluation build.
It scopes the upstream objc2 assertion workaround to that dependency for this
explicit build; normal build profiles are unchanged. This is not a signed release
or a general macOS support guarantee.

The updated frontend build and 261 frontend tests passed on Windows. The Mac
native rebuild passed (47.04 seconds for the native build), and the new process
remained alive with an empty launch log. Binary SHA-256:
`9740eec955d8f978be64fdb10d54764e34f40227d343e8734482eaec0b93e91b`.
Mac evidence: `.local/mac-validation/build-bootstrap.log`,
`build-bootstrap.exit` (0), `launch-bootstrap.log`, and `runtime-compat.log`.
The user then confirmed the desktop rendered, with a screenshot showing layout
defects: a 540-pixel desktop inside a taller native window, clipped app windows,
and missing spacing. This confirms startup, not complete native-client acceptance.

### Layout and dialog follow-up

Unsupported dynamic viewport units now have `vh` fallbacks. Window geometry uses
physical edge properties rather than the unsupported `inset` shorthand. Blur has
the WebKit prefix. A measured flex-gap probe activates a small compatibility
stylesheet for desktop chrome and core Files/Terminal controls; grid gaps and
modern engines retain native spacing.

A fixture loaded the actual application CSS in this Mac's WKWebView. At a
1360-by-780 viewport it measured the desktop at 1360-by-780, the window area and
maximized window at 1360-by-654 starting below the 44-pixel toolbar, the caption
near the bottom, and the expected 9-pixel brand gap. All assertions passed.
The built/minified CSS also retains the viewport fallback and physical edges.

The same engine reported both `HTMLDialogElement` and `showModal` unavailable.
The standard `dialog-polyfill` is therefore loaded before desktop initialization
only when native modal support is absent. Core dialogs use the shared opening
helper, and Settings joins the other dialogs in a portal directly under body to
avoid the desktop's stacking context. The fallback backdrop and positioning are
scoped to fallback dialogs; native modal behavior remains in use elsewhere.

A second real WKWebView fixture passed visible geometry, initial autofocus,
backdrop creation, close event/return value/backdrop removal, reopening, and
Escape cancellation. Evidence remains in `layout-probe.log` and
`dialog-probe.log` under the Mac's `.local/mac-validation/` directory. These are
focused engine checks, not an end-to-end SSH/clipboard test or an exhaustive
audit of every dialog's spacing. The frontend regression suite passes 261 tests.

The final Mac debug rebuild passed in 1 minute 10 seconds and was launched for
the user's visual check. Its SHA-256 is
`e4d241c6f51bf6555e731df048640f69922cea848420ebc82c6993254cf43c2c`.
Final build/launch evidence is in `build-dialog.log`, `build-dialog.exit` (0),
and `launch-dialog.log`. The shared frontend also passed a normal Windows native
debug build. Final visual confirmation on the Mac remains separate from the
automated fixture results.

## Remaining evidence

The user separately tested the Windows desktop client connected to this Mac over
SSH on 2026-09-09. Their screenshot shows the Mac's `/Users/user/MuAndroid`
directory in Files and its logged-in shell prompt in Terminal. This is evidence
of remote Mac file browsing and an established SSH console from Windows; it does
not validate a native Mac client, file writes, transfers, or clipboard behavior.

For the native Mac client, complete interactive desktop acceptance, SSH browsing/terminal operation,
clipboard interoperability, a distributable app bundle and signing remain to be
verified on this machine. Installed third-party UI frames are still gated on
macOS pending native isolation tests. Non-Windows adapter descendant cleanup is
also a separate open requirement; a successful desktop launch would not close it.
