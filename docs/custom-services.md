# Custom device services

An adapter can expose its own namespaced JSON methods to installed apps without adding vendor operations to the desktop. For example, a sensor adapter can advertise `acme.sensor.read`, while Files and Terminal come from different connections in the same workspace.

## Adapter and workspace

Advertise the service during the [process handshake](adapter-process.md):

```json
{ "id": "acme.sensor", "version": 1, "methods": ["acme.sensor.read"] }
```

For app routing, service IDs use lowercase dot-separated segments, each beginning with a letter and containing letters, digits or hyphens (180 bytes maximum). The first segment cannot be `system`, `files`, `console`, `host`, `terminal` or `services`. Methods must belong to that exact namespace; subsequent segments may contain uppercase letters. Method names are at most 200 bytes. Versions are positive integers. Advertised descriptors are fixed for a connection generation.

In **Connect a host → Use connection adapters**, enter `acme.sensor` in that source's **Additional services** field. Multiple IDs are comma-separated. Each service has one explicitly selected source. Selecting an unadvertised custom service fails connection setup; the desktop never silently substitutes another source. A workspace can supply only custom services, without Files or Terminal.

The Rust `CustomService` trait lives in `shellcanvas-services`. The process bridge implements it independently of SSH. Other trusted native implementations can use the same trait. The workspace wraps the service with connection ownership and a fresh opaque binding identity. Closed workspaces and disconnected sources refuse calls; an old completion cannot become a result from a new connection.

## App permission and SDK

Declare `services.acme.sensor` in the app manifest. The normal installer lets the user approve or deny it. This grant covers the advertised methods of that service, not other service namespaces or unrestricted native commands. Existing windows retain their reviewed package/grant generation when the app is updated.

```ts
import { connectToShellCanvas } from "@shellcanvas/app-sdk";

const desktop = await connectToShellCanvas();
const method = (await desktop.services.list()).find(
  (item) => item.name === "acme.sensor.read",
);
if (method?.version === 1 && method.available && method.granted) {
  const result = await desktop.services.call("acme.sensor.read", {
    sensor: "room",
  });
  // Validate the result against the adapter's documented service contract.
}
```

`services.list(signal?)` merges built-in broker methods and the workspace's selected custom methods. Custom entries contain the adapter's service `version`, required `permissions`, separate `granted`/`available` flags and an opaque `source` binding identity. Source identity is informational; the app cannot pass a source or native session ID to select a different connection.

`services.call(method, params?, signal?)` dispatches through `system.services.call`. The trusted broker finds the declared method, checks its service grant and current availability, then captures its exact native binding. JSON is the service boundary; the SDK does not infer vendor parameter or result schemas. The lower-level `client.call` remains a direct broker-method call and should not be used to bypass custom service dispatch.

Reconnect keeps the app document and shows **Use reconnected host**. Custom methods remain unavailable until the user accepts that connection. Discovery still supplies local desktop methods while remote access awaits approval. After acceptance, new calls use fresh bindings. Calls already dispatched retain their original owner.

## Cancellation and failures

Pass an `AbortSignal` to cancel. Closing the app or retiring its session also cancels pending calls. Cancellation propagates through the native request and process protocol; it cannot undo remote effects. The process bridge has a 30-second deadline, bounded frames and bounded in-flight work. Large data transfers belong in streaming/paged contracts, not a single JSON result.

Adapter errors retain supported SDK `RpcError.code` values. A process `deadline` maps to `failed` with its message. Dispatched errors include an uncertainty explanation; connection loss after dispatch also reports uncertainty. Do not automatically retry operations that might mutate a device. A provider must define idempotency and any recovery protocol in its own service contract.

## Example and evidence

`examples/service-inspector` is a standalone SDK app. Build it with `node packages/app-sdk/bin/shellcanvas-app.mjs build examples/service-inspector`, then install its package through Apps. The [practice adapter](adapter-packages.md#prepare-a-practice-package) supplies `acme`; select that additional service and approve the app's `services.acme` permission to try its echo button. The example uses synthetic device data and requires no remote credentials.

The adapter desktop probe installs the adapter and two app permission variants through the real Windows desktop. It checks discovery, denied access, JSON echo, adapter errors, cancellation reaching the separate process, disconnected discovery and explicit reconnect approval with a fresh binding. Native unit tests check foreign bindings, retired owners, malformed/reserved namespaces and uncertain late completion. These checks do not establish support for a particular physical device or protocol.

Independent [source replacement](adapter-packages.md#replace-one-connection) now preserves unaffected apps and requires acceptance in affected app windows. Native discovery is filtered by the app's captured source identities, including the interval between commit and frontend acceptance; it cannot reveal replacement method bindings through an old handle. Persisted composite profiles, adapter SDK/schema generation and cross-platform native evidence remain separate [delivery gates](kernel-roadmap.md).
