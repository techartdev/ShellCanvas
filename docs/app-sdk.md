# Standalone app development

Apps can now be [installed directly from a public GitHub repository](repository-apps.md)
using a root manifest and verified prebuilt package. The optional
[app connection API](app-network.md) provides user-configured HTTP endpoints and
native credential storage without giving the isolated app unrestricted network access.

The public [window API](app-window.md) provides window snapshots, focus, minimize,
maximize, restore and guarded close requests, in addition to document state.

The public [clipboard API](app-clipboard.md) supports text and RGBA images with
separate grants. Its native fixture uses synthetic clipboard content and native
image resources; it does not replace the user's system clipboard.

The canonical runtime client and public types now live in `packages/app-sdk`. The desktop re-exports these same implementations, so the standalone package and host contract do not maintain separate copies. Native host brokers and storage/clipboard ownership remain in the desktop. The existing Field Notes example imports `@techartdev/shellcanvas-app-sdk` by package name.

The package is not published to npm yet. From a fresh repository checkout:

```powershell
npm ci
npm run test:sdk
New-Item -ItemType Directory -Force .local/sdk-releases
npm pack --workspace @techartdev/shellcanvas-app-sdk --pack-destination .local/sdk-releases
node packages/app-sdk/bin/shellcanvas-app.mjs init .local/my-notes --id org.example.notes --title "My Notes" --sdk .local/sdk-releases/shellcanvas-app-sdk-0.1.0.tgz
```

In the generated directory, run `npm install` and `npm run build`. Install its `dist/app.shellcanvas.json` through the desktop Apps manager. An independent developer needs the SDK tarball and Node, not the ShellCanvas source checkout. The package includes built JavaScript, TypeScript declarations, schemas, a starter, build/validation tools and the MPL-2.0 license. See [the API and error reference](../packages/app-sdk/README.md).

## Start with one feature

The generated notebook demonstrates several services; its full implementation is
not the minimum required for an app. For a first local utility, replace `main.ts`
with the following and reduce `shellcanvas.json` permissions to `["system.dialogs"]`:

```ts
import { connectToShellCanvas } from "@techartdev/shellcanvas-app-sdk";

const root = document.querySelector<HTMLDivElement>("#root")!;
root.innerHTML =
  '<button disabled>Say hello</button><output role="status"></output>';
const button = root.querySelector("button")!;
const report = (error: unknown) => {
  root.querySelector("output")!.textContent = String(error);
};
connectToShellCanvas()
  .then((desktop) => {
    button.disabled = false;
    button.onclick = () => {
      void desktop.system.dialogs
        .messageBox({
          title: "Hello",
          message: "A local app using a shared desktop dialog.",
        })
        .catch(report);
    };
  })
  .catch(report);
```

Build and install it with the same commands. This app needs no remote host,
adapter, file handles, connection events or custom close handler. The desktop
owns the dialog's lifetime. Denied permission is reported as an error; use
`services.list()` if the app should disable a denied or unavailable feature.

Add responsibilities only when the app gains the corresponding behavior:

| App behavior            | What its author adds                                              |
| ----------------------- | ----------------------------------------------------------------- |
| Unsaved edits           | Dirty state; retain drafts after failed saves                     |
| Local persistent data   | App storage and its revision checks                               |
| Remote files            | File grants, opaque locations/revisions and availability handling |
| Console or transfer     | Own the returned stream/job and close it when finished            |
| Device-specific actions | A grant and call for that adapter's custom service                |

Apps do not implement transports, broker messages, native session identifiers,
package leases or host cleanup. Those are desktop/SDK responsibilities. See the
[base API boundary](kernel-roadmap.md#base-api-boundary-and-stopping-rule) for the
milestone's stopping rule.

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

This establishes the app SDK packaging path. The [adapter SDK/schema/custom-service starter](adapter-sdk.md), [AI development skills](ai-development-skills.md) and [window lifecycle API](app-window.md) are also implemented. Remaining work is tracked in the current [kernel delivery gates](kernel-roadmap.md). Registry publication is an explicit release action through the manual SDK workflow.

The SDK also exposes [remote consoles](app-console.md) with `system.console` permission, byte streams, flow control, optional resizing and window-owned cleanup. The adapter integration fixture checks binary I/O through the independently built SDK app and actual native process transport. [File transfers](app-transfers.md) have preparation, progress, cancellation and window-owned handles, verified through Windows integration. [Remote settings](app-host-settings.md) have separate read/write grants, provider-defined fields, revision-checked apply and host-owned busy guards. The current Windows installed-app walkthrough passes 91 checks, including remote settings cancellation, read-only grants, reconnect protection and clipboard ownership. Earlier checkpoint counts are historical; see the [acceptance audit](kernel-acceptance.md) for the retained evidence. These process-adapter bridges and the initial developer tooling are implemented; remaining requirements and platform evidence are tracked in the kernel roadmap.
