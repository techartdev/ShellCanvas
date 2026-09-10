---
name: shellcanvas-package
description: Prepare, validate, update or troubleshoot installable ShellCanvas app and native adapter packages. Use for extension packaging and runtime lifecycle work, not operating-system installers or registry publishing in general.
---

Determine whether the artifact is an isolated UI app or a native adapter. Read
the corresponding guide: [runtime apps](../../docs/runtime-apps.md) or
[adapter packages](../../docs/adapter-packages.md). They have different formats
and trust boundaries; do not present a native executable as a sandboxed UI app.

## Produce a reviewable artifact

For an app, use the public `shellcanvas-app build` and `validate` commands from
[the app SDK](../../packages/app-sdk/README.md). Bundle app code and styles with
the declared manifest/permissions. External code consumes the SDK, not host IPC.

For a GitHub-distributed app, generate the root descriptor with
`shellcanvas-app repository` after building. Read [repository distribution](../../docs/repository-apps.md).
Commit the descriptor and the exact prebuilt bytes; preserve those bytes with
Git attributes. Verify an actual repository installation and reviewed update.
Do not require users to build source or run package-manager scripts at install time.

For an adapter, use `shellcanvas-adapter build` for a generated Rust project, or
`pack SOURCE_JSON EXECUTABLE NEW_OUTPUT` for an existing executable. Then run
`validate NEW_OUTPUT/adapter.json`. The [adapter SDK reference](../../crates/adapter-sdk/README.md)
describes source placeholders, schemas and the optional version override. These
commands validate/copy/hash assets without installing or connecting the package.
Package the entire output directory, not just its JSON manifest.

Use a new output directory/version for an update. Keep existing artifacts intact.
An incomplete package from a failed build/copy is not a successful result. Exclude
credentials and private device data; password configuration has no packaged
secret default. Metadata/hash validation is not publisher authentication.

## Runtime lifecycle

Review app permissions or native-code trust for the actual artifact being
installed. Existing user authorization determines whether to install or deliver
the artifact for review; this skill does not authorize unrelated publication,
registry uploads, live-device connections or changes to machine configuration.

Existing app windows retain their code/grants; existing adapter connections retain
their executable generation. An update does not silently move running operations
to the new package. Preserve drafts and busy-work guards. Removing an adapter
package can leave its already-owned connection running; disconnect/replacement
is a separate action. Removal must not bypass window-close safeguards for apps.

On failure, inspect the current catalog revision and active owners before retrying.
Do not delete package objects or staged files manually to defeat leases/reviews.
Never retry an uncertain device mutation as a packaging repair.

## Evidence

Run the appropriate standalone export check (`npm run verify:sdk` or
`npm run verify:adapter-sdk`) when changing packaging/tooling. The native fixture
guides above exercise review/install/update/remove and retained generations in
separate application data. Verify the user's actual app/device behavior in
addition to package mechanics when that is part of the task. Keep the artifact,
source revision, platform, checks and unverified behavior identifiable in the
handoff. Do not label a debug executable as a signed release or installer.
