# Install apps from GitHub

Open **App Manager → Add apps → From GitHub** and enter `owner/repository` or its GitHub
HTTPS URL. Choose a branch, tag or commit (default `main`). The desktop reads
`shellcanvas.repo.json` directly from GitHub's raw file host, then downloads the
named prebuilt package. No app server, registry, GitHub REST/GraphQL API, local
Git checkout, dependency install or build-script execution is involved.

Repository reads use a fresh cache key and request cache revalidation for both
the descriptor and package, so a manual update check does not reuse a previously
cached branch response. Package hashes are still checked before showing review;
if a branch changes between downloads, retry the integrity-failed check.

The initial flow supports publicly readable repositories. Private repository
authentication is not included. Package-file installation remains available for
private builds. The assistant's public repository is
[techartdev/ShellCanvas-Assistant](https://github.com/techartdev/ShellCanvas-Assistant).

## First-party recommendations

The App Manager's default **Installed** page also shows apps curated by
ShellCanvas. These suggestions come from the repository-root
[`shellcanvas.catalog.json`](../shellcanvas.catalog.json). A copy is bundled
into the desktop so suggestions appear immediately and remain available
offline. On opening or refreshing App Manager, the desktop checks the fixed
`techartdev/ShellCanvas` repository at `main` for the current manifest and uses
it only after full validation. Once a client with live catalog support is
released, catalog additions and edits on `main` do not require another desktop
release.

A catalog entry supplies display text and an explicit GitHub
`owner/repository/ref`, and pins the expected app identifier. Choosing
**Review** still downloads that app repository's normal
`shellcanvas.repo.json` and package, verifies its SHA-256 and package identity,
and opens the standard permission review. A recommendation neither installs an
app nor approves access. “Recommended by ShellCanvas” describes curation by
this repository; it is not a cryptographic publisher identity.

To add another first-party app, publish its prebuilt package and root descriptor
as described below, then add its canonical source and app ID to
`shellcanvas.catalog.json` on `main`. Sources must remain under the `techartdev`
GitHub owner, IDs must be unique, and the catalog must match
[`docs/schemas/app-catalog.schema.json`](schemas/app-catalog.schema.json). Test
the catalog parser, the live repository review, and the permission screen before
merging the catalog change into `main`.

## Root descriptor

```json
{
  "format": 1,
  "kind": "app-repository",
  "id": "org.example.notes",
  "version": "0.1.0",
  "title": "Notes",
  "description": "A small independent app.",
  "package": {
    "path": "dist/app.shellcanvas.json",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
}
```

Generate the real digest; the example is illustrative. The public SDK command:

```sh
npm run build
shellcanvas-app repository . --description "A small independent app."
```

Without `--description`, the command uses the package's own `description`. The
App Manager shows the repository description only for apps whose package has
none.

`--path` selects another repository-relative package path. The command reads an
already built valid package and atomically writes the descriptor. Commit the
descriptor and artifact together. Preserve exact artifact bytes in Git, for
example with `dist/app.shellcanvas.json -text` in `.gitattributes`. Source and
build tooling may be in the same repository but are not run by the installer.

The SDK exports `./repository` plus `./schemas/app-repository.schema.json`.
Unknown fields, malformed identifiers and unsafe paths are rejected. Paths must
use simple ASCII filename segments and remain below the repository root.

### Optional native companion

A repository app may declare one required native adapter. Each platform entry
points to that adapter's normal `adapter.json` and pins its raw SHA-256:

```json
"nativeAdapter": {
  "id": "org.example.notes-connector",
  "version": "0.1.0",
  "packages": [{
    "platform": "windows-x86_64",
    "path": "dist/adapter-windows-x86_64/adapter.json",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }]
}
```

This is available only for GitHub repository installs because local app files
do not identify where native package assets came from. App Manager downloads
the exact platform package from the same owner, repository and reference,
verifies the manifest and every declared asset, then shows one review that
separates app permissions from native-code trust. Approval installs the app and
the staged adapter; it does not launch the adapter, connect it or collect its
configuration. Hash pins provide content integrity, not publisher authentication.

An identical enabled adapter is reverified and reused. A disabled dependency
must be enabled under **Connection adapters** before reviewing again. Managed
updates may replace the app's prior pinned adapter, while an unknown legacy
installation or another installed app's conflicting pin blocks replacement.
Existing running connections retain their generation. Installation is a
recoverable two-step commit: if the native commit fails, the desktop restores
the exact preceding app generation when it is still safe; a concurrent app
change or open candidate window can require separate manual cleanup.

`shellcanvas-app repository` preserves and validates an existing
`nativeAdapter` declaration when regenerating package hashes, so repository
builds do not silently remove the pin. Older descriptors without this field and
local app-file installation remain app-only.

Apps installed with a native companion may explicitly connect that companion
from their own UI. Discover `system.companion.connect` before using this desktop
API through the SDK's low-level `client.call`:

- `system.companion.connect({ configuration })` validates fields against the
  installed, enabled, hash-pinned companion and opens one window-owned session.
  The app cannot supply adapter IDs, executable paths, workspace IDs or bindings.
- `system.companion.status()` returns `{ connected, binding }`, with an opaque
  binding identity. `system.companion.list()` describes the connected methods.
- `system.companion.call({ method, params })` checks the app's service grants
  before dispatching to its own session. Ordinary `services.call` continues to
  address the accepted workspace.
- `system.companion.disconnect()` cancels pending setup and closes that session.
  Closing the app also cancels pending setup and releases the session. Credentials
  remain in memory and are not stored as a workspace profile.

The `system.companion` event invalidates connection state. A connection attempt
is bounded to 45 seconds and can be canceled through the SDK signal. Successful
replacement closes the preceding session; failed setup leaves it available.
This API connects endpoints reachable from the desktop PC; it does not create
SSH tunnels or discover remote database instances.

## What verification means

The raw artifact SHA-256 must match the descriptor. Package format, identity,
title, version and permissions are validated before review. Review displays
repository/ref, package version, permission requests and fingerprints. Nothing
executes until the user installs and launches the app. Hash validation detects
changed/corrupt bytes; it does not authenticate a publisher or audit code.

The installer stores source provenance with the installed generation. **Check
update** repeats download, verification and permission review against that
source. New permissions are unselected on updates. A changed app ID is refused
as an update. A manually supplied replacement from a different source gets a
visible source-change notice. A pinned commit checks that same commit; select a
new reference explicitly to upgrade it.

Existing app windows retain their package/grants. Updates do not replace their
running code. Closing an old window and opening a new one uses the new generation.
Catalog compare-and-set still rejects stale reviews and competing installations.

Downloads accept at most 64 KiB for the descriptor and 32 MiB for the package,
have bounded concurrency/timeouts, reject redirects, and cancel the native
request when the dialog is canceled or retired. A branch moving between the two
downloads can produce a hash mismatch: review it again; do not bypass the check.
