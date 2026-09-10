---
name: shellcanvas-app
description: Build or extend an installable ShellCanvas desktop app using its public SDK and shared system services. Use for community apps and external app workflows, rather than ordinary changes to the bundled desktop shell.
---

Build the user's app as a runtime package. Locate the ShellCanvas checkout through
`packages/app-sdk` and read [the public SDK guide](../../docs/app-sdk.md) plus
[the SDK API/command reference](../../packages/app-sdk/README.md). Keep the user's
app in its own project; it must not import desktop `src/`, Tauri IPC or Rust host
internals. Use the SDK's packaged distribution. The current SDK is provisional;
do not assume its package name is published to npm.

## Create and build

Use the SDK CLI to initialize a new directory with the user's chosen namespaced
ID, title and the supplied SDK tarball. With the CLI installed, the command is:

```sh
shellcanvas-app init APP_DIR --id org.example.notes --title "Notes" --sdk SDK_TARBALL
```

Resolve the directory and tarball arguments before running it. Follow the
generated project's install/build commands. `shellcanvas-app validate` checks
the resulting `dist/app.shellcanvas.json`. For an existing app, edit its current
project rather than generating over it. Preserve the user's visual direction;
shared desktop dialogs and window chrome should remain consistent with the host.

## Use the kernel APIs

- Declare permissions for the operations the app actually uses. The runtime
  package manifest has `permissions`; do not copy unsupported fields from the
  bundled app manifest. Use service discovery to distinguish availability from
  grants and disable unsupported actions while keeping local work accessible.
- Use shared message boxes, Open/Save pickers and `saveTextAs` through the SDK.
  A picker chooses a location; it does not authorize an unchecked overwrite.
- Treat file locations, revisions and accepted source bindings as opaque. Retain
  them with documents. A source change must not redirect an old save to a new host.
- Report title, dirty and busy document state. Keep drafts after conflicts,
  disconnect or uncertain writes. Cancellation is not rollback or permission to
  replay a mutation; refresh and let the user decide what to do.
- Use app storage/settings for local data, byte-oriented consoles for terminals,
  native transfer jobs for file contents, and `services.<id>` for a selected
  custom device service. Avoid protocol or OS assumptions in app UI.
- Own listeners, streams and jobs by the app window. Dispose them on teardown.
  Render device text as text; remote labels and file contents are not UI markup.
- For HTTP model/API connections, use `network.configure` and `network.postJSON`
  with `system.network`. Let the host credential dialog collect secrets; never
  store keys in app settings, history, manifests or attachments. Close streamed
  responses in `finally`; cancellation does not authorize automatic retries.

Read only the relevant service guide: [files](../../docs/app-files.md),
[console](../../docs/app-console.md), [transfers](../../docs/app-transfers.md),
[clipboard](../../docs/app-clipboard.md), [settings](../../docs/app-host-settings.md),
or [custom services](../../docs/custom-services.md). For user-configured HTTP,
read [network connections](../../docs/app-network.md); for direct GitHub installs,
read [repository distribution](../../docs/repository-apps.md).

## Verify the result

Build and validate the package, then exercise its actual workflow in an installed
window. Include missing capability, denied permission, cancellation, reconnect
and unsaved-close behavior when those paths affect this app. Use synthetic
services unless a real device is part of the authorized task.

The checkout's `npm run verify:sdk` exports/installs the SDK in fresh outside
projects and builds examples. The [runtime app guide](../../docs/runtime-apps.md)
describes native integration fixtures and their scope. Distinguish package
validation, installed-window evidence and real-device behavior in the report;
none automatically proves the others. Installation/publication is separate from
building an artifact. Follow existing user authorization for external actions.
