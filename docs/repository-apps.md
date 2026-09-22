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
[`shellcanvas.catalog.json`](../shellcanvas.catalog.json), which is bundled into
the desktop build. Catalog additions and edits therefore ship with a
ShellCanvas desktop release; opening the store does not silently replace the
curated list from the network.

A catalog entry supplies display text and an explicit GitHub
`owner/repository/ref`, and pins the expected app identifier. Choosing
**Review** still downloads that app repository's normal
`shellcanvas.repo.json` and package, verifies its SHA-256 and package identity,
and opens the standard permission review. A recommendation neither installs an
app nor approves access. “Recommended by ShellCanvas” describes curation by
this repository; it is not a cryptographic publisher identity.

To add another first-party app, publish its prebuilt package and root descriptor
as described below, then add its canonical source and app ID to
`shellcanvas.catalog.json`. Sources must remain under the `techartdev` GitHub
owner, IDs must be unique, and the catalog must match
[`docs/schemas/app-catalog.schema.json`](schemas/app-catalog.schema.json). Test
the catalog parser, the live repository review, and the permission screen before
shipping the next desktop release.

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
