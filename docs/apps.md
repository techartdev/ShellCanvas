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
  icon: MyIcon,
  component: MyApp,
  // Optional: omitted apps launch on demand in a standard window.
  window: { layout: "standard", openOnStart: false },
}
```

The registry checks IDs, API version, scope, known capabilities and layout. Launcher, dock, generic window and focus behavior come from the shell. No shell startup list or app-specific window CSS is needed. `primary` and `secondary` layouts preserve the default Files/Terminal arrangement; `standard` is the default for other apps. Styling the app's own content remains its responsibility.

Local apps declare `scope: "local"` and `requires: []`; they can render without connecting. A host app declares only the services it needs. A host-information view can use no extra capabilities beyond its required connection. Disconnected or unsupported apps get an explanatory state automatically.

Unavailable apps cannot be newly launched; existing windows remain accessible after capability loss so local work can be recovered. A disconnected desktop still lets the user open an app's connection prompt. Future service bindings may mix protocols: consume the service rather than checking for SSH, SFTP or a particular OS. Fine-grained optional capability states are tracked by BASE-10.

## Lifecycle

- **Open:** a normal dock click restores/focuses an existing instance. Apps can opt into multiple instances through their manifest.
- **Minimize:** hides its window but keeps component state and remote resources alive.
- **Close:** unmounts the component. Clean up subscriptions, timers, transfers and channels in effect cleanup. Closing Terminal ends that shell; minimizing keeps it alive.
- **Workspace switch:** preserves app instances and bindings. **Connection loss:** preserves local work while disabling remote actions. **Reconnect:** replaces the binding while keeping components mounted; refresh remote views when the session ID changes and preserve unsaved drafts. Explicit workspace closure unmounts its apps. Never retain an old service handle for new operations; stale handles reject calls.
- **Failure:** a React error boundary contains rendering/lifecycle failures and offers reopen. Handle rejected promises and event-handler failures explicitly with app state or `reportError`; React boundaries do not catch those.

An app's `services` is now a `SessionServices` handle: `list(path)`, `preview(path)` and `terminal(cols, rows, onEvent)`. It captures the owning workspace; apps cannot pass another session ID or access profile/connection administration through this handle. Unavailable services and disposed handles reject calls. Check `active` for UI such as portal menus that should disappear when the workspace is hidden; switching workspaces does not unmount the app. Capability declarations control availability, not security: bundled modules still share native webview access. Per-extension grants and composite service bindings remain future work.

## Acceptance checklist

File apps consume provider-owned locations: call `services.list()` for the default folder and use returned `name`, `parent`, `home`, `roots` and entry paths. Text documents supply their own name and parent. Do not split paths, add separators, infer an OS or invent a root. See [the filesystem contract](filesystem-contract.md).

Apps can opt into `window.multiple: true`. `context.openApp(appId, { path })` creates another eligible instance in the same workspace; its initial payload is available through `context.launch`. Launch payloads contain navigation intent only, never commands or credentials. The dock's normal click focuses an existing instance, while its menu and the titlebar plus button create a new one. Each instance has independent component state and terminal cleanup.

- Render meaningful loading, empty, unavailable and failure states.
- Keep keyboard focus, accessible button labels and narrow-screen behavior usable.
- Cancel or disregard late async results after unmount/host replacement; close handles that finish opening after the app closes.
- Never build remote commands in the component or import credentials.
- Preserve the desktop palette and spacing; put technical details in the app only when they help its user.
- Test behavior with a fake service before touching a live host. Use only explicitly authorized hosts and disposable paths for writes.

## Failure recovery fixture

With `npm run dev`, open `/tests/fixtures/app-boundary.html`. Trigger the app failure, increment the sibling counter, then reopen the failed app. The sibling count must remain intact and the failed app must mount again. This fixture intentionally logs a React error and is not included in the production entry point. Desktop lifecycle and manifest validation are covered by `src/desktop.test.ts`.
