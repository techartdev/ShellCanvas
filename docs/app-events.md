# App environment, service discovery and state events

The runtime client offers `environment.get()`, `services.list()` and `events.subscribe()`. These expose the owning window's public state and registered broker methods. They do not accept native session IDs, foreign window IDs or another app's identity. No extra permission is required to inspect this metadata; invoking each service still requires its declared, approved permissions.

```ts
const client = await connectToShellCanvas();
const methods = await client.services.list();
const open = methods.find(
  (method) => method.name === "system.dialogs.openFile",
);
if (open?.version === 1 && open.granted && open.available) {
  // Availability is a snapshot. The call can still fail if its connection changes.
  const files = await client.system.dialogs.openFile();
}

const unsubscribe = client.events.subscribe((batch) => {
  for (const event of batch.events) {
    if (event.topic === "system.environment") {
      console.log("This window's environment", event.value);
    }
    if (event.topic === "system.services") {
      // An invalidation, not a cached full method table.
      void client.services.list().then(renderAvailability, showError);
    }
  }
}, showError);
// When the component no longer needs updates:
unsubscribe();
```

## Environment and binding lifetime

`environment.get(signal?)` returns an API-version-1 snapshot with:

- `connection`: `local`, `connected`, `disconnected`, or `review-required`.
- `binding`: an opaque accepted-binding identity, or `null` for a local workspace. It is not a native session handle and is not comparable across app instances.
- `visible`: whether this window is visible in the active workspace, including minimization.
- `capabilities`: the host's current advertised capability names. Capability presence does not confer a permission.

A reconnect preserves the document and its current binding identity but retires its old remote operations. While the desktop offers **Use reconnected host**, the environment is `review-required` and the affected remote methods are unavailable. Explicit acceptance creates a different binding identity for subsequent calls. Already dispatched work never changes its target. Local storage remains independent of that remote binding.

The Field Notes sample renders connection-state events without overwriting its editor or operation result. It continues to report dirty/busy state through `window.setDocumentState`; environment events do not grant permission to discard unsaved work.

## Discovery and invocation

`services.list(signal?)` returns the actual registered method names, their contract version (currently 1), required `permissions`, `granted` state, and `available` state. Discovery includes only the app broker's method map, never the native command dispatcher. Permission denial and temporary unavailability are distinct. The broker checks permissions before availability and checks availability before invoking a handler.

The method map supports namespaced custom methods, such as `acme.sensor.read`. A host-supplied `RpcMethod.available()` predicate can report changing availability without replacing the method's handler or owner. Discovery reads the same predicate as invocation. This is a building block for adapter/service registration; a runtime adapter installer and custom-service routing from provider processes remain separate roadmap work.

The older standalone workbenches do not supply a full desktop environment. Their default environment is local; methods without an availability predicate report registered availability and still enforce their underlying system-scope checks. The normal desktop supplies connection/capability-aware predicates for its remote operations.

## Event contract

Events are ordered state notifications with `{ sequence, topic, value }`. The current topics are `system.environment` (a complete environment snapshot) and `system.services` (a `null` invalidation; query discovery again). Each batch has `{ cursor, reset, events }`.

The SDK delivers an initial snapshot and fans one underlying stream out to multiple independent listeners. A newly added listener receives current snapshots. Each listener receives a clone, so mutating it cannot affect another listener or the host. Callback failures are sent to that listener's error callback. Asynchronous callbacks are observed for rejection but do not pause delivery; coordinate any asynchronous rendering in the app. Unsubscribing stops future callbacks synchronously; work already started inside a callback belongs to the app.

The last unsubscribe aborts the pending read. Closing or disposing the app channel retires its host subscription, event journal and pending read. A later subscription on a live channel starts with a fresh snapshot. Channel failure calls the error handlers and stops the stream; it does not silently reconnect or select another host.

The underlying `system.events.next({ after })` call is for SDK implementers. `after: null` requests current topic snapshots. Otherwise the cursor must be a nonnegative safe integer from that instance, no greater than its current sequence. One read can wait per instance. It wakes on a new event or is canceled with its RPC request. Apps should use the SDK fan-out rather than start competing raw readers.

The journal retains at most 128 events and 64 topic snapshots. An event payload is at most 16 Ki UTF-16 units of JSON; topics are namespaced and at most 200 characters. If a reader falls behind the retained history, `reset: true` explicitly supplies current snapshots. This is a state-notification stream, not a durable audit log or a lossless binary stream. Consumers must resynchronize on reset; transfers use their own streaming/backpressure contracts.

## Verification

`npm test -- src/extensions/app-events.test.ts src/extensions/rpc.test.ts` checks bounded replay/reset, snapshot isolation, foreign-instance separation, invalid cursors, canceled/retired reads, SDK listener fan-out, listener failures, unsubscribe/re-subscribe, arbitrary custom namespaces and live availability enforcement.

The native desktop integration probe verifies discovery through the real SDK/opaque frame, denied file permissions in a new app version, file unavailability while reconnect approval is pending, an explicitly changed binding identity, disconnect/reconnect notifications and minimize/restore visibility events. It uses fake host services and leaves real remote hosts untouched.
