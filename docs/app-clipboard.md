# Clipboard API for runtime apps

## Copy remote files to the system clipboard

`client.clipboard.copyFiles(entries, signal?)` publishes remote file/folder
references to the native clipboard. Entries are `{ binding, path, revision }`
snapshots from one accepted workspace binding. Declare both
`system.clipboard.files.write` and `files.download`. Copy does not delete sources.
On Windows, Explorer requests file contents later through native streaming;
successful Copy means the selection was published, not that a destination copy
has finished. Keep ShellCanvas and the source connection running until Paste ends.

```ts
await client.clipboard.copyFiles(selectedEntries, signal);
```

The SDK snapshots references and sends ordered chunks of at most 128 entries,
normally within 64 Ki UTF-16 units of JSON. An individual longer opaque reference
still has to fit the RPC envelope. There is no total-selection count cap. The
broker stages root references in memory; native folder discovery uses the disk
catalog and does not fetch file contents at Copy. Duplicate names, unsupported
folders, unsafe Windows names and stale source revisions are checked natively.

One window owns one staging/publication slot. Incomplete staging never publishes.
Publication contributes mandatory busy state to close/quit guards. Cancellation
requests native preparation cleanup and retains busy state until it settles.
Closing or changing the accepted binding retires staged references and cancels
pending preparation. Cancellation after native publication may be too late; do
not automatically retry an uncertain result. Completed clipboard contents retain
their original provider even after the exporting app window closes; source
retirement cannot silently reroute deferred streams to a different device.

This API currently publishes to the Windows system clipboard. That selection
can also be pasted by installed apps and the bundled Files window in the same
ShellCanvas process and original workspace. Custom formats, other
native platforms and transfer between separate ShellCanvas processes remain
follow-ups. Neither text nor image grants authorize file exports.

SDK/broker tests cover chunking, captured revisions, grants, ownership,
malformed staging, cancellation/registration races, replacement and closure.
The independently built app passes 91 Windows integration checks, including export,
denial and mandatory busy guards through cancellation. It uses synthetic clipboard
services; it does not touch the user's clipboard or claim a new Explorer test.

## Cut remote files and folders

`client.clipboard.cutFile(entry, signal?)` publishes one revision-checked move
reference on Windows. Supply `{ binding, path, revision }` from the accepted
workspace, and declare `system.clipboard.files.write` plus `files.move`.

```ts
await client.clipboard.cutFile(selectedEntry, signal);
```

Publication does not move or delete the item. An installed app or bundled Files
can paste it within the same ShellCanvas process and original workspace/provider.
The public Cut method does not export file contents to Explorer: Move permission
does not imply Download permission. Use `copyFiles` with `files.download` for
external file content export. Bundled Files can additionally offer Explorer a
streamed copy when its workspace supports Download; that external copy retains
the remote source.

Cut snapshots the entry before awaiting and shares Copy's exclusive publication
slot and mandatory busy guard. Cancellation requests cleanup; a publication
already dispatched may still complete. Do not automatically retry an uncertain
result. Source replacement never redirects the pending publication. Once
published, the native selection outlives the app window, subject to its original
source lifetime. Multiple-item cuts remain pending.

## Files copied on this device

`client.clipboard.pasteFiles(destination, signal?)` prepares clipboard transfers
to a `{ binding, path }` remote directory. Declare `system.clipboard.files.read`
and the required operation grant: `files.upload` for local file lists, `files.copy`
for copied ShellCanvas selections, or `files.move` for a cut ShellCanvas item.
The SDK inspects the clipboard kind/version without returning file paths, then
uses the corresponding permission-checked preparation method. Missing grants
never trigger a fallback to another transfer kind or source.

Remote selections retain their original workspace and native file-service
instance. Another workspace, a replaced source or a clipboard version change is
refused. Repeated Copy pastes create independent metadata catalogs and output paths;
they do not mutate the published selection. A clipboard change after a paste has
captured its selection does not redirect that transfer. Source revisions are
checked through normal discovery and transfer operations.

A Cut retains its move intent when an installed app pastes it in the
same process and original workspace. Its handle has `direction: "move"` and needs
only the provider's move service, not upload/download/copy services. One native
reservation owns the cut: another paste is refused while it is pending. Canceling
before dispatch releases that reservation; Cancel cut retires the selection and
invalidates prepared reservations. Once dispatched, the operation waits for the
provider's authoritative result even after cancellation. A failed, abandoned or
unacknowledged dispatched move is never replayed; refresh and explicitly cut again
after checking the destination. Confirmed relocations update tracked desktop
folders and editor locations. A busy editor/transfer blocks the move before dispatch.

If that blocked start cannot release its native reservation, the ticket remains
owned for cleanup only. The SDK's `run()` reports the failed operation, while
`status()` remains `cancel-failed` without a terminal `result` until cleanup is
confirmed. `cancel()` or `close()` retries release without running the move again.
The desktop keeps its busy/close guard and host cleanup retry action, including
after the app disappears. Bundled Files shows **Retry cleanup** for the same case.
Late cancellation responses from an older cut cannot unlock or restore it over
a newer clipboard operation.

Native unit tests cover reservation ownership, move-only providers, late cancellation,
provider errors/panics and abandoned operations. SDK/broker/session tests cover grants,
stale binding cleanup and relocation tracking. The Windows native desktop fixture
passes 91 checks at 1360×900, including installed-app Cut into bundled Files,
bundled Cut into an installed app, publication/move-grant denial, failed reservation
cleanup, retry controls and close guards. The preceding 88-check checkpoint also
passed at 800×900. It runs the
real app frame/SDK/broker/UI with synthetic host and clipboard services. This does
not establish new Explorer/Finder interoperability.
Multiple-item cuts and moves across processes remain open.

```ts
const jobs = await client.clipboard.pasteFiles(destination, signal);
for (const job of jobs) {
  try {
    const result = await job.run(signal);
    // Present the authoritative result, including partial failure or cancellation.
  } finally {
    await job.close();
  }
}
```

Preparation does not start uploads. Returned handles use the same status, watch,
cancel and close contract as [other transfers](app-transfers.md). The desktop keeps
pending preparation and unfinished jobs busy even if an app reports itself idle.
Late tickets after cancellation, closure or source replacement are cleaned up;
native root preparation itself currently finishes before that cleanup occurs.

Windows accepts Explorer's file-list format (CF_HDROP) and this process's own
remote selections. An empty or
non-file clipboard returns no jobs. Native input paths never appear in SDK ticket
fields. Files and folders share one disk-backed selection catalog and one queued
job; file contents open on demand and are checked against captured metadata.
Folders require provider folder-transfer support. A locally cut selection uploads
a copy and retains its source. Other applications' virtual-file formats and native
macOS/Linux file clipboard input are not yet supported. Custom-format APIs remain
separate work.

## Images

`client.clipboard.readImage(signal?)` returns `{ width, height, rgba }`, where
`rgba` is a `Uint8Array` with four bytes per pixel in top-to-bottom row order.
`writeImage(image, signal?)` publishes that format. Dimensions must be positive
integers and match the exact byte count. Native desktop access uses the installed
clipboard plugin; browser preview reads/writes PNG through browser clipboard and
canvas APIs, subject to browser support and permissions. Mobile image clipboard
support is not claimed.

Declare `system.clipboard.image.read` and/or `system.clipboard.image.write`.
Text clipboard grants do **not** authorize images. Installation shows separate
image permission labels, and service discovery reports absent backend methods as
unavailable. These methods never interpret pixels as files, paths or commands.

```ts
const image = await client.clipboard.readImage();
// Edit pixels in your app, then explicitly copy the resulting image.
await client.clipboard.writeImage(image);
```

The app-to-desktop channel streams at most 32 KiB of RGBA bytes per request.
Writes snapshot the caller's pixels before awaiting; reads hold a captured image
even if the system clipboard changes. Incomplete or misordered images never reach
the native publisher. No arbitrary total-image cap is introduced; images still
need memory for their pixels and must fit the JS/native/OS image representation.
This is not a disk-backed image or zero-copy API.

Each window owns one image read and one staged image write, independently of its
text streams. A canceled backend read or dispatched publication retains its slot
until it settles. Closing releases staged buffers and rejects further calls.
Native image resource handles are released after extraction/publication, including
error paths. Cancellation cannot retract an image already sent to the OS, and an
uncertain publication is never retried automatically. Writes replace clipboard
content; no atomic multi-format publication or cross-app write ordering is promised.

Synthetic protocol tests cover large images, exact bytes, permissions, ownership,
ordering, cancellation and uncertain writes. Native wrapper tests verify resource
cleanup on success/failure. The Windows installed-app fixture round-trips an image
through the broker and native image resources with an injected clipboard, and
checks denied reads after a permission change. It does not overwrite the user's
OS clipboard or establish a Paint/Explorer image interoperability result.
The complete fixture passes 71 checks at both 1360×900 and 800×900.

Cross-process clipboard integration and custom formats remain separate work.

The file-paste checkpoint passes 73 Windows installed-app checks at 1360×900,
including successful paste through the independently packaged SDK and denied
access without invoking the backend. Clipboard content is synthetic; this does
not replace the user's clipboard or establish a new live Explorer walkthrough.

## Text

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

The shared file clipboard checkpoint passes all 80 Windows installed-app checks
at 1360×900, including installed-app to installed-app, installed-app to bundled
Files and bundled Files to installed-app Copy/Paste. Native tests check rejection
of foreign workspaces/replaced providers and independent catalogs for repeated
pastes. Broker tests check clipboard changes and separate copy/upload grants.
Clipboard services in these integration checks are synthetic.

The subsequent Windows checkpoint passes 91 installed-app checks at 1360×900,
including public `cutFile` publication, denied publication permission and paste
into bundled Files. The 88-check checkpoint at 800×900 covers the earlier shared
Cut/move and cleanup guards. These counts describe different checkpoints; they
do not establish live Windows clipboard image interoperability. The separate
opt-in [live image runner](live-image-clipboard-validation.md) now passes both
directions for opaque 2×2 images using the production service and an independent
Windows reader/writer.

The app API provides text, images, native file paste and native file export. The
bundled Files app's workspace Copy/Cut path is documented separately in
[system-clipboard.md](system-clipboard.md). Copy selections are shared with
installed apps on Windows. Cut selections retain their move intent across installed
apps and bundled Files in the original workspace. Cross-process moves and custom
formats remain open.

`npm test -- src/extensions/clipboard-api.test.ts` exercises real RPC channels with synthetic clipboard contents: a text value larger than one RPC envelope, split surrogate pairs, empty text, snapshot consistency, separate permissions, foreign handles, ordered chunks, incomplete commits, cancellation during staging/startup, late completion, exclusive native publication and close cleanup.

The Windows desktop integration fixture routes the separately built SDK app through the real WebView2 frame/broker to an injected synthetic clipboard. It checks large/empty text round trips and an updated app with read permission withheld. No test clipboard content is printed, and this fixture does not touch the user's OS clipboard. The normal backend uses the same native text service as bundled terminal/editor actions; a new live OS clipboard walkthrough is not claimed by the synthetic probe.
