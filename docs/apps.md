# Build a bundled desktop app

The current SDK is a trusted source-module API. There is no download/install mechanism, sandbox, stable published package or permission enforcement for third-party JavaScript. API version 1 marks this development contract, not a promise of long-term compatibility.

## Start from Host details

`src/apps/HostDetails.tsx` is a small working reference: it reads the current provider snapshot, uses a generic window, and requires no Linux-specific logic, commands or additional network calls. Files and Terminal demonstrate asynchronous services and cleanup.

1. Add a React component under `src/apps/` accepting `AppContext`.
2. Add its manifest/import to `src/apps/registry.ts`. Choose a unique lowercase ID, preferably `author.app-name` for contributed apps.
3. Run `npm run build` and `npm test`; inspect it in the browser preview and then against the intended native services.

```tsx
{
  apiVersion: 1,
  id: "yourname.my-app",
  title: "My app",
  subtitle: "A short description of what it does",
  scope: "host",
  requires: ["files.read"],
  optional: ["files.edit"], // Saving enhances this app; browsing can stand alone.
  icon: MyIcon,
  component: MyApp,
  // Optional: omitted apps launch on demand in a standard window.
  window: { layout: "standard", openOnStart: false },
}
```

The registry checks IDs, API version, scope, known capabilities and layout. Required and optional capabilities cannot overlap or contain duplicates. It copies and freezes declarations so later mutation cannot change the service policy. Launcher, dock, generic window and focus behavior come from the shell. No shell startup list or app-specific window CSS is needed. `primary` and `secondary` layouts preserve the default Files/Terminal arrangement; `standard` is the default for other apps. Styling the app's own content remains its responsibility.

Local apps declare `scope: "local"`, `requires: []` and no optional remote capabilities; they can render without connecting. Host apps put launch requirements in `requires` and enhancements in `optional`. Both authorize calls through the supplied service handle when the host supports them, but missing optional capabilities do not block launch. A host-information view can use no extra services beyond its connection snapshot. Disconnected or unsupported apps get an explanatory state automatically. Existing contributed modules that called undeclared services must now declare them.

Unavailable apps cannot be newly launched; existing windows remain accessible after capability loss so local work can be recovered. A disconnected desktop still lets the user open an app's connection prompt. Future service bindings may mix protocols: consume the service rather than checking for SSH, SFTP or a particular OS. Fine-grained optional capability states are tracked by BASE-10.

## Lifecycle

- **Open:** a normal dock click restores/focuses an existing instance. Apps can opt into multiple instances through their manifest.
- **Minimize:** hides its window but keeps component state and remote resources alive.
- **Close:** unmounts the component. Clean up subscriptions, timers, transfers and channels in effect cleanup. Closing Terminal ends that shell; minimizing keeps it alive.
- **Workspace switch:** preserves app instances and bindings. **Connection loss:** preserves local work while disabling remote actions. **Reconnect:** replaces the binding while keeping components mounted; refresh remote views when the session ID changes and preserve unsaved drafts. Explicit workspace closure unmounts its apps. Never retain an old service handle for new operations; stale handles reject calls.
- **Failure:** a React error boundary contains rendering/lifecycle failures and offers reopen. Handle rejected promises and event-handler failures explicitly with app state or `reportError`; React boundaries do not catch those.

An app's `services` is a `SessionServices` handle: `list(path)`, `preview(path)` and `terminal(cols, rows, onEvent)`. The generic window supplies a stable scope for the app manifest and workspace binding. Undeclared methods reject before calling the provider. The underlying workspace still checks host support, ownership and connection lifetime; declarations cannot grant a capability the host lacks. Apps cannot pass another session ID or access profile/connection administration through this handle. Transfer tickets can be run/canceled only by the app scope that acquired them; caller-supplied ticket metadata does not change their direction or ownership. Instances of the same app share the scope, while their UI queues remain independent.

Move-capable app scopes share the workspace's file clipboard and its disconnect cleanup. This preserves Cut/Paste between Files windows. A scope without declared `files.move` cannot acquire move access through the clipboard. `session.info.capabilities` remains a host metadata snapshot, not an app permission list: only the manifest's declared services are callable. Check `active` for UI such as portal menus that should disappear when the workspace is hidden; switching workspaces does not unmount the app.

These checks prevent accidental undeclared calls by trusted source modules. They are **not an isolation boundary for hostile JavaScript**: bundled modules share the webview, can import native IPC and can reach other trusted code. External package execution, native enforcement of extension grants, revocation and composite binding policy remain separate work. No user permission prompts or credential access are introduced here. See [service declarations](app-services.md).

## Acceptance checklist

Optional `host.settings` exposes `readHostSettings()` and `applyHostSetting(id, value, revision)`. The provider owns field definitions and validation; do not branch on OS names in the component. Preserve proposals after errors, review before apply, and keep busy/unsaved guards through result verification. See [the remote settings contract](remote-settings.md).

File apps consume provider-owned locations: call `services.list()` for the default folder and use returned `name`, `parent`, `home`, `roots` and entry paths. Text documents supply their own name and parent. Do not split paths, add separators, infer an OS or invent a root. See [the filesystem contract](filesystem-contract.md).

File transfers use optional `files.upload` and `files.download` capabilities. `chooseUploads(parent)` and `chooseDownload(path, revision)` return native-owned tickets; `runTransfer(ticket, onProgress)` streams through the native broker, and `cancelTransfer(id)` requests cancellation. Use the existing `TransferQueue`, retain busy guards until cancellation/completion is confirmed, and release pending tickets on disposal. Do not expose arbitrary local paths or send file bytes through the app component. See [transfer limits](transfers.md).

Apps can opt into `window.multiple: true`. `context.openApp(appId, { path })` creates another eligible instance in the same workspace; its initial payload is available through `context.launch`. Launch payloads contain navigation intent only, never commands or credentials. The dock's normal click focuses an existing instance, while its menu and the titlebar plus button create a new one. Each instance has independent component state and terminal cleanup.

- Render meaningful loading, empty, unavailable and failure states.
- Keep keyboard focus, accessible button labels and narrow-screen behavior usable.
- Cancel or disregard late async results after unmount/host replacement; close handles that finish opening after the app closes.
- Never build remote commands in the component or import credentials.
- Preserve the desktop palette and spacing; put technical details in the app only when they help its user.
- Test behavior with a fake service before touching a live host. Use only explicitly authorized hosts and disposable paths for writes.

## Failure recovery fixture

With `npm run dev`, open `/tests/fixtures/app-boundary.html`. Trigger the app failure, increment the sibling counter, then reopen the failed app. The sibling count must remain intact and the failed app must mount again. This fixture intentionally logs a React error and is not included in the production entry point. Desktop lifecycle and manifest validation are covered by `src/desktop.test.ts`.
