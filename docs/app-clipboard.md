# Clipboard API for runtime apps

Runtime apps use `client.clipboard.readText(signal?)` and `client.clipboard.writeText(text, signal?)`. The normal desktop routes these through its existing native text clipboard service; the browser preview uses the browser clipboard API and its permission/focus requirements. The app frame itself remains denied direct clipboard access.

Declare `system.clipboard.read` and/or `system.clipboard.write` in the app package. The installation review labels them **Read clipboard text, including content from other apps** and **Replace clipboard text**. They are separate permissions. Updates do not silently approve newly requested permissions. Discovery exposes both the registered methods and their granted state; permission denial is enforced before the backend is called.

```ts
const client = await connectToShellCanvas();
await client.clipboard.writeText("Copied from my app");
const text = await client.clipboard.readText();
```

Reading is an explicit app request, not an automatic desktop poll. An app approved for reading can request text from the shared system clipboard, so approve that permission accordingly. Clipboard text is never interpreted as a local path, shell command or file-transfer request. Writing replaces the shared clipboard, including content placed there by other applications.

Field Notes demonstrates **Copy note** and **Paste text**. It queries discovery to enable those controls without reading the clipboard during startup. Paste inserts at the captured text selection and refuses to overwrite edits made while the read was pending. Copy does not mark the remote document saved.

## Streaming and ownership

The simple API uses a window-owned transfer internally. Text is exchanged in chunks of at most 64 Ki UTF-16 units, so the complete text does not have to fit in the broker's 4 Mi control-message envelope. Chunks preserve ordering and Unicode even when a surrogate pair crosses a boundary. Empty text is supported. No application-imposed total text-size limit is added here; normal runtime, OS allocation and clipboard implementation limits still apply.

A read captures the text returned by the backend once. Later clipboard changes do not alter that in-progress snapshot. A write stages ordered chunks and publishes only after the declared length is complete. Incomplete, reordered or foreign operations cannot publish. Each window permits one captured read and one staged/in-flight write; overlapping operations of the same kind return `busy`.

This is bounded message delivery, not constant-memory storage of arbitrarily large text. The native clipboard API, the host's captured read/staged write, and the calling app ultimately hold complete text values. The service does not retain an OS clipboard lock while the app requests chunks. It is distinct from remote file/folder transfers, which stream file contents and use a disk-backed metadata catalog.

The SDK chooses an operation identity before starting, allowing cleanup even when cancellation wins the race with the initial acknowledgement. Identities are scoped to one app window, not global native handles. Every SDK operation releases its reservation in `finally`; closing/disposal retires the owner and drops staged text. A late native read cannot publish a new handle after cancellation or closure.

Cancellation before commit leaves the system clipboard unchanged. A native write already dispatched may still complete; cancellation cannot undo it, and the host never retries it automatically. Concurrent writes from other apps follow the backend's normal clipboard ordering. This API does not promise clipboard history or compare-and-swap publication against external applications.

## Scope and evidence

This app API currently handles text. The bundled Files app's native file/folder Copy/Paste path is documented separately in [system-clipboard.md](system-clipboard.md); those file-transfer operations and image/custom-format clipboard access are not yet exposed through this runtime client. The broker's explicit namespaced method map allows additional formats/services to be added without changing the existing text contract.

`npm test -- src/extensions/clipboard-api.test.ts` exercises real RPC channels with synthetic clipboard contents: a text value larger than one RPC envelope, split surrogate pairs, empty text, snapshot consistency, separate permissions, foreign handles, ordered chunks, incomplete commits, cancellation during staging/startup, late completion, exclusive native publication and close cleanup.

The Windows desktop integration fixture routes the separately built SDK app through the real WebView2 frame/broker to an injected synthetic clipboard. It checks large/empty text round trips and an updated app with read permission withheld. No test clipboard content is printed, and this fixture does not touch the user's OS clipboard. The normal backend uses the same native text service as bundled terminal/editor actions; a new live OS clipboard walkthrough is not claimed by the synthetic probe.
