# Standalone app development

The public [window API](app-window.md) provides window snapshots, focus, minimize,
maximize, restore and guarded close requests, in addition to document state.

The public [clipboard API](app-clipboard.md) supports text and RGBA images with
separate grants. Its native fixture uses synthetic clipboard content and native
image resources; it does not replace the user's system clipboard.

The canonical runtime client and public types now live in `packages/app-sdk`. The desktop re-exports these same implementations, so the standalone package and host contract do not maintain separate copies. Native host brokers and storage/clipboard ownership remain in the desktop. The existing Field Notes example imports `@shellcanvas/app-sdk` by package name.

The package is not published to npm yet. From a fresh repository checkout:

```powershell
npm ci
npm run test:sdk
New-Item -ItemType Directory -Force .local/sdk-releases
npm pack --workspace @shellcanvas/app-sdk --pack-destination .local/sdk-releases
node packages/app-sdk/bin/shellcanvas-app.mjs init .local/my-notes --id org.example.notes --title "My Notes" --sdk .local/sdk-releases/shellcanvas-app-sdk-0.1.0.tgz
```

In the generated directory, run `npm install` and `npm run build`. Install its `dist/app.shellcanvas.json` through the desktop Apps manager. An independent developer needs the SDK tarball and Node, not the ShellCanvas source checkout. The package includes built JavaScript, TypeScript declarations, schemas, a starter, build/validation tools and the MPL-2.0 license. See [the API and error reference](../packages/app-sdk/README.md).

## Verification

The SDK includes [remote text services](app-files.md): binding-aware reads, create-only writes and revision-checked saves. Field Notes uses these to open and edit a remote note while retaining the reviewed source identity. The installed-app desktop probe exercises these operations and rejects old documents after reconnect.

`npm run test:sdk` checks source/package schema agreement, safe starter creation and preservation of the previous artifact when a build fails. These checks are included in `npm run verify`.

`npm run verify:sdk` packs the SDK and installs it into newly created projects under the operating system's temporary directory, outside this repository. It generates and type-checks a starter, builds and validates the package, and builds native probe artifacts through the installed tarball. It saves a report and distributable starter/SDK under `.local/sdk-verification/`. Temporary projects are retained for diagnosis; the script prints the exact path. This step may download pinned build dependencies and is separate from the regular local verification command.

After that, run the generated starter through the actual Windows desktop:

```powershell
npm run tauri -- build --debug --no-bundle --config src-tauri/tauri.sdk-probe.conf.json
node scripts/run-extension-probe.mjs
```

The fixture installs the independently built starter through the real Apps manager and tests shared message/open/save dialogs, local storage and unsaved-close handling inside the isolated frame. The starter gets test-only DOM controls to automate its opaque frame. The OS file chooser is supplied a fixture package; no real remote host or system clipboard is used. Native results go to `.local/native-extension-probe/result.json`.

For the existing lifecycle/permissions/clipboard walkthrough using the same independently installed SDK, set `SHELLCANVAS_SDK_PROBE=1` for the build and use `src-tauri/tauri.desktop-probe.conf.json`. Restore the normal executable afterward with `npm run verify -- --native`. Browser inspection is also available at `tests/fixtures/sdk-starter-probe.html?inspect=1` after generating the artifacts.

The SDK also supports [custom adapter services](custom-services.md) through explicit per-service grants. `verify:sdk` independently builds the Device Services example, which uses `services.list` and `services.call`. Set `SHELLCANVAS_SDK_PROBE=1` and build `src-tauri/tauri.adapter-probe.conf.json` to exercise that artifact alongside the separate adapter process in the Windows fixture.

This establishes the app SDK packaging path. The standalone adapter SDK/schema/starter, repository AI skills, further lifecycle actions and the other [kernel delivery gates](kernel-roadmap.md) remain open. No package has been published to a registry by this workflow.

The SDK also exposes [remote consoles](app-console.md) with `system.console` permission, byte streams, flow control, optional resizing and window-owned cleanup. The adapter integration fixture checks binary I/O through the independently built SDK app and actual native process transport. [File transfers](app-transfers.md) have preparation, progress, cancellation and window-owned handles, verified through Windows integration. [Remote settings](app-host-settings.md) have separate read/write grants, provider-defined fields, revision-checked apply and host-owned busy guards. The Windows installed-app walkthrough passes 56 checks, including remote settings cancellation, read-only grants and reconnect protection. Remaining process-adapter bridges and developer tooling are tracked in the kernel roadmap.
