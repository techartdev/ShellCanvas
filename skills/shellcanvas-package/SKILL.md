---
name: shellcanvas-package
description: Package, validate, install, update or troubleshoot a ShellCanvas app package or native adapter package, including GitHub distribution and what happens to running windows and connections. Use for extension delivery and lifecycle, not operating-system installers.
---

Two artifact kinds exist and they are not interchangeable. An **app package** is
a single JSON file containing bundled code, styles and a manifest; it runs
sandboxed with reviewed permissions. An **adapter package** is a directory of
native files with hashes; it runs as a process with the user's own permissions.

Decide which one you are handling before touching anything, and never present a
native executable as a sandboxed app.

```sh
npx shellcanvas-app validate dist/app.shellcanvas.json     # app
shellcanvas-adapter validate ./dist/my-device/adapter.json # adapter
```

Both commands only parse and hash. Neither installs, connects, or proves the
extension works. Building each kind is covered by the `shellcanvas-app` and
`shellcanvas-adapter` skills; this one is about delivery and what happens after.

## Produce a reviewable artifact

Build into a new output and leave existing artifacts intact, because a package
someone already installed must stay exactly as it was.

For an app, `npm run build` type-checks and packs; `--version 0.2.0` on
`shellcanvas-app build` overrides the artifact version without editing the
manifest. For an adapter, `shellcanvas-adapter build DIR NEW_OUTPUT` compiles and
packs a generated Rust project, while `pack SOURCE_JSON EXECUTABLE NEW_OUTPUT`
packages an already-built executable from any language.

An update means a new version and a new output directory — never an overwrite in
place. A failed build or copy leaves an incomplete directory: retry into a fresh
one rather than repairing it by hand. Exclude credentials and private device
data; a password configuration field may not carry a packaged default.

Metadata and hash validation is not publisher authentication.

## Distribute through GitHub

A repository can serve an app directly, with no registry, no token and no build
step on the user's machine.

```sh
npm run build
npx shellcanvas-app repository . --description "What your app does."
```

Commit the built `dist/app.shellcanvas.json` and the generated root
`shellcanvas.repo.json` together, and protect the bytes with
`dist/app.shellcanvas.json -text` in `.gitattributes`. The descriptor records the
package's SHA-256, so any rewrite — including an automatic line-ending
conversion — breaks installation with a hash mismatch.

Users install with **App Manager → Add apps → From GitHub**, review the exact
downloaded package, and update the same way.
<https://shellcanvas.com/docs/extensions/install-apps.html>

## Know what an update does to running work

Installing a new version never reaches into what is already running, which is
deliberate and occasionally surprising.

An open app window keeps the code and the grants it started with until it is
closed; a new window gets the new version. An active adapter connection keeps
its own executable generation, so removing an adapter package can leave a
running connection alive — disconnecting or replacing it is a separate,
explicit act.

Nothing silently migrates in-flight operations to new code. Draft protection and
busy guards still apply, so removal cannot bypass a window's unsaved-changes
prompt. Plan updates around that rather than assuming a restart semantics that
does not exist.

## Review trust before installing, every time

Installation is the moment a person decides what this code may do, and it is the
only such moment.

For an app, read the declared permissions and ask whether the feature genuinely
needs each one. For an adapter, understand that you are approving native code
that runs with your own operating-system permissions: hashes tell you the bytes
match what was reviewed, not that the author is trustworthy. There is no
signing, no marketplace and no vetting.

Existing user authorisation decides whether to install or merely to hand the
artifact over for review. This work does not authorise publishing to a registry,
connecting to a live device, or changing machine configuration.
<https://shellcanvas.com/docs/extensions/permissions.html>

## Troubleshoot a refused package

Most failures are the package, not the desktop, and the message says which.

A schema or manifest refusal means the package was built against different rules
— rebuild it with a current SDK. A compatibility refusal means the package
declares a client platform this desktop does not satisfy. In App Manager,
selection stays disabled until the installed-app catalog has loaded; acting
early produces a complaint that clears on refresh, so wait for the control to
enable rather than retrying.

For an adapter that installs but will not run, the host-side timeline in
**Connection adapters → Connection diagnostics** is the useful artifact, and it
is redacted by design.

Do not delete package files or staged directories by hand to force a retry, and
never re-run an uncertain device mutation as a packaging repair.
<https://shellcanvas.com/docs/troubleshooting/apps.html>

## Report what was actually verified

Keep the artifact, its version, the platform and the checks apart from each
other in any handoff, because they prove different things.

Validation proves the bytes parse. An installed window or a connected adapter
proves the desktop accepted it. Only exercising the real workflow proves it
works, and only against a real device does it prove device support. State which
of these you did, and name what you did not verify rather than leaving it
implied.

A debug build is not a signed release, and ShellCanvas installers themselves are
unsigned. Do not describe either as more than it is.
