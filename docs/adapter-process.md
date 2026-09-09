# Native adapter process contract (provisional v1)

Rust adapter authors can use the [standalone adapter SDK](adapter-sdk.md) for
framing, concurrent request dispatch and cancellation instead of implementing
the server loop themselves. Other languages can implement this same contract.

`crates/adapter-runtime` can launch a separately compiled, trusted executable and consume its services without linking its protocol implementation into the host. It supplies version negotiation, service discovery, concurrent calls, cancellation, process teardown, and bridges to the existing `ConnectionLifecycle`, `FileSystemProvider` and `TerminalService` interfaces.

The desktop provides [reviewed adapter installation and connection configuration](adapter-packages.md), independent file and console sources, custom-service routing into runtime app permissions and independent source replacement. The synthetic adapter implements neither FTP nor serial.

## Launch and trust

`AdapterProcess::launch(Launch { executable, arguments, directory }, configuration, deadline)` requires absolute executable and working-directory paths. It invokes the executable directly, with a structured argument vector, without a shell or PATH lookup. Pass credentials/configuration in the initialization message, not arguments. Configuration and wire data are not logged by this host. Standard error is currently discarded; a reviewed diagnostics channel is pending.

Adapters are native programs running with the user's OS permissions and inherited environment. UI app grants do not sandbox them. The installer requires an explicit native-code trust decision. Never let an isolated app frame supply a launch path or arguments.

Windows launch paths must explicitly end in `.exe`; batch files and shortcuts are rejected. An adapter implemented in a scripting language can use an explicit interpreter executable with its script as a separate argument. This avoids Windows batch-file argument handling described in [Rust's process documentation](https://doc.rust-lang.org/std/process/struct.Command.html#method.arg). Literal arguments, including spaces, quotes and shell metacharacters, are covered by the process fixture.

One process represents one established connection generation. Clones and service handles retain that generation. `close()` invalidates dispatch immediately, cancels pending work and kills/reaps the directly owned process; all close waiters observe the same cleanup result. Dropping the last owner also starts cleanup. Cleanup continues if its caller is canceled. A separate adapter process remains usable when another exits or violates the protocol.

On Windows the process uses `CREATE_NO_WINDOW`; Tokio's `kill_on_drop` is a fallback when its owner disappears. These APIs manage the directly spawned process. Adapters must not leave child processes behind; process-tree containment/job objects and equivalent non-Windows verification remain open. See [Tokio's process ownership documentation](https://docs.rs/tokio/latest/tokio/process/struct.Command.html#method.kill_on_drop) and [Microsoft's creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags).

## Framing and negotiation

Stdin/stdout are dedicated to the protocol. Every frame is a four-byte, big-endian unsigned byte count followed by exactly that many UTF-8 JSON bytes. Empty frames, malformed JSON, unknown envelope fields, incompatible versions and unsolicited request IDs retire the connection. A frame is at most 4 MiB. Bulk APIs must use pages/chunks; this is not a total file, folder or stream size ceiling. Encoding and decoding enforce the frame bound before growing the framing buffer beyond it.

The host sends the first request:

```json
{
  "v": 1,
  "type": "request",
  "id": 1,
  "method": "system.adapter.initialize",
  "params": { "protocol": 1, "configuration": {} }
}
```

The adapter replies after configuration/connection setup:

```json
{
  "v": 1,
  "type": "result",
  "id": 1,
  "value": {
    "protocol": 1,
    "services": [
      { "id": "acme.sensor", "version": 1, "methods": ["acme.sensor.read"] }
    ]
  }
}
```

Each service ID and method consists of dot-separated identifier segments, starts each segment with a letter, and uses letters, digits or hyphens thereafter (200-byte maximum). Method names must start with their service ID plus a dot. Service IDs and methods must be unique; service versions are positive integers. `system` and `system.*` are reserved for the host. The catalog is immutable for this process generation; reconnect/replacement requires a fresh instance and explicit binding selection.

Only declared methods can be called through `AdapterProcess::call`. Unknown service namespaces remain usable through that generic method without a core code change. A standard Rust bridge is exposed only when its exact service version and required methods are present; a files-only connection does not claim a console.

Subsequent requests use the same request shape. Responses may arrive out of order:

```json
{"v":1,"type":"result","id":2,"value":{"temperature":21.5}}
{"v":1,"type":"error","id":3,"code":"denied","message":"This device refuses the operation"}
{"v":1,"type":"cancel","id":4}
```

The host sends `cancel`; the adapter sends `result` or `error`. Error codes are `invalid`, `closed`, `aborted`, `denied`, `unavailable`, `busy`, `failed`, or `deadline`; error messages are at most 4096 UTF-8 bytes and must not disclose credentials. IDs increase within a process and remain JavaScript-safe integers. Replies to already completed/canceled IDs are discarded, never assigned to another call.

## Cancellation and resource use

The host allows 32 in-flight calls per connection and bounded pipe queues. Additional calls receive `busy` before dispatch. This bounds concurrent work, not the number of files that can be transferred sequentially. Dropping a call future or reaching its deadline releases the waiter and sends a cancellation notification when dispatch occurred. Cancellation cleanup is wake-driven with a 100ms fallback sweep. A stuck input pipe or exhausted output queue retires the failing connection rather than accumulating unbounded frames.

Adapters must process requests concurrently: a pending console read cannot prevent writes, close or cancellation. An operation may already have produced effects when canceled. The host never retries a request automatically. `AdapterError.outcome_uncertain` conservatively marks dispatched failures/deadlines; callers must inspect mutations before retrying. A successful cancellation is not an undo operation. Native implementations must clean up their resources on cancellation and process exit.

## Files v1

The `files` service requires `files.list`, `files.locate`, and `files.preview`:

| Method          | Parameters                                                   | Result                                         |
| --------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| `files.list`    | `{path: string or null, cursor: string or null, limit: 128}` | `{directory: Directory, next: string or null}` |
| `files.locate`  | `{path: string}`                                             | `FileLocation`                                 |
| `files.preview` | `{path: string}`                                             | Text preview string                            |

`Directory` and `FileLocation` use the camelCase shapes in `shellcanvas-services`. Each page has directory metadata and up to 128 entries. `next: null` finishes the listing. Cursors are stateless/provider-owned continuation tokens: they must not allocate a retained server handle requiring a later release. The adapter must preserve listing identity or reject stale cursors; it must not silently switch locations between pages. Empty/unchanged next cursors and changed directory paths are rejected.

Paths, parent locations, roots and cursor tokens remain opaque. The host does not split/join/normalize them or send them to a different service source. The compatibility bridge collects pages for the current browser's materialized `Directory` result, with a 30-second operation deadline. It is not a constant-memory directory UI. Recursive transfers use the separate incremental directory reader described below. There is no new total-entry count limit.

## Optional file methods v1

An adapter with the base `files` service can additionally advertise these methods. All parameters and results use the camelCase service-contract shapes; locations and revisions belong to the provider.

| Method                | Parameters                                    | Result                     |
| --------------------- | --------------------------------------------- | -------------------------- |
| `files.readText`      | `{path}`                                      | `TextDocument`             |
| `files.createText`    | `{parent, name, text}`                        | `TextDocument`             |
| `files.saveText`      | `{path, text, revision}`                      | `TextDocument`             |
| `files.makeDirectory` | `{parent, name}`                              | New folder location string |
| `files.rename`        | `{path, name, revision, tracked: string[]}`   | `FileRelocation`           |
| `files.move`          | `{path, parent, revision, tracked: string[]}` | `FileRelocation`           |
| `files.remove`        | `{path, revision}`                            | `null` after removal       |

`TextDocument` contains `path`, `parent`, `name`, `text`, `revision`, and `writable`. Its location and revision must be nonempty. `files.readText` enables text access independently of write support; create and save advertise separate desktop capabilities. Without `files.saveText`, returned documents are forced read-only. The existing mutation contract groups make-directory, rename, and remove: all three must be advertised to enable `files.manage`. Move is independent. These services share the selected Files source and its namespace.

Creation must refuse existing destinations. Save, rename, move and remove must validate the supplied revision before changing the device. An adapter must implement the provider's conflict and publication semantics; the host does not manufacture atomicity or retry a write. `FileRelocation` contains `{path, locations: [{previous, location: FileLocation}]}`. Return provider-computed mappings for affected tracked locations; never ask the desktop to infer descendants by parsing paths. Empty locations and duplicate `previous` mappings are rejected.

Calls have the standard 30-second deadline and frame bound. Invalid write responses and failures whose outcome is uncertain tell the caller that the change may have completed and needs inspection before retry. Cancellation cannot undo an already-dispatched change. Binary and folder transfers use the streaming methods below.

## Streaming transfers v1

Transfers use the selected `files` service and its opaque namespace. Download and upload are independent optional method groups; copy requires both. `files.transfer.abort` is required for either direction. Every open receives a host-generated UUID before dispatch, including opens that are later canceled.

| Method                  | Parameters                      | Result                                              |
| ----------------------- | ------------------------------- | --------------------------------------------------- |
| `files.download.open`   | `{id, path, revision}`          | `{location: FileLocation, size: u64}`               |
| `files.download.read`   | `{id, offset, maxBytes: 32768}` | Byte array; empty means EOF                         |
| `files.download.finish` | `{id}`                          | `null` after source verification and close          |
| `files.upload.open`     | `{id, parent, name, size: u64}` | `null` after opening unpublished temporary data     |
| `files.upload.write`    | `{id, offset, bytes}`           | `null` after accepting this chunk                   |
| `files.upload.finish`   | `{id}`                          | Published `FileLocation`                            |
| `files.transfer.abort`  | `{id}`                          | `null` after resource release and temporary cleanup |

Reads and writes are at most 32 KiB, with explicit byte offsets. Downloads must match the declared size. Finish validates that the source still has the reviewed revision; copy verifies the source before publishing the destination. Upload finish must publish without replacing an existing destination. Abort removes only unpublished data: it must never delete a file whose publication already completed, even if the host lost the finish reply. Adapter errors must distinguish uncertain mutations in their message. The host does not replay writes or finish calls.

Abort must be idempotent and retire unknown or still-opening IDs. A late open may not recreate a retired resource. Adapters must handle requests concurrently so a blocked read/open does not block abort. The host retains an open permit until confirmed finish or cleanup, including cleanup after a dropped caller. There are 32 permits shared across transfer service handles for one adapter process. Failed abandoned cleanup keeps that slot charged until reconnect; this bounds leaked remote resources without capping total files, bytes or tree depth. An explicit cleanup failure is returned to the caller. Dropping the handle makes one further best-effort idempotent cleanup attempt.

Once a read/write/finish starts, its handle is unusable for another stream operation until the reply is validated. Cancellation, malformed replies and uncertain results leave it abortable but prevent continuation at an unknown offset. Standard operations have a 30-second per-call deadline; abort has a three-second deadline. A successful publication is authoritative even when cancellation arrives afterward.

### Folder transfers

Advertise all of the following methods to enable the existing recursive-transfer contract:

| Method                   | Parameters             | Result                                        |
| ------------------------ | ---------------------- | --------------------------------------------- |
| `files.transfer.entry`   | `{path, revision}`     | Revision-checked `FileEntry`                  |
| `files.directory.open`   | `{id, path, revision}` | `null` after opening the checked directory    |
| `files.directory.next`   | `{id, limit: 128}`     | Up to 128 `FileEntry` values; empty means EOF |
| `files.directory.finish` | `{id}`                 | `null` after verification and close           |
| `files.transfer.mkdir`   | `{parent, name}`       | Newly created `FileLocation`                  |

Directories use the same abort contract and permit budget. A directory reader holds only one page at a time; the native tree engine stores traversal metadata in its disk catalog. There is no whole-tree response or new tree-entry/depth limit. The provider validates revisions, returns unique child identities and owns path handling. Folder creation must refuse merging with an existing destination. The existing engine rejects links, cycles, unsafe names and incompatible destination aliases. Providers may advertise `files.transfer.entry` without the rest of the folder methods to inspect regular files directly; otherwise regular-file inspection opens and aborts a download.

## Remote settings v1

Advertise service ID `host`, version 1, with `host.settings.read` and optionally `host.settings.apply`. The workspace role is **Remote settings** (`host.settings`), which can be assigned independently of Files and Terminal.

| Method                | Parameters              | Result                 |
| --------------------- | ----------------------- | ---------------------- |
| `host.settings.read`  | `null`                  | `HostSetting[]`        |
| `host.settings.apply` | `{id, value, revision}` | Verified `HostSetting` |

A field contains `id`, `label`, `description`, nullable `value` and `revision`, `editor` (`text` or `select`), `choices: string[]`, `writable`, and nullable `reason`. IDs must be nonempty and unique; supplied revisions must be nonempty. Without apply support or a revision, the host makes the field read-only. An apply must check the supplied revision, perform the provider operation, and return verified state with the requested ID, value and revision. Missing confirmation is an uncertain outcome. Provider-specific validation and authorization belong to the adapter.

## Console v1

The `console` service requires `console.open`, `console.read`, `console.write`, and `console.close`. `console.resize` is optional:

| Method           | Parameters                            | Result                               |
| ---------------- | ------------------------------------- | ------------------------------------ |
| `console.open`   | `{id, cols, rows}`                    | `{resizable: boolean}`               |
| `console.read`   | `{id, maxBytes: 65536, waitMs: 1000}` | `{bytes: number[], closed: boolean}` |
| `console.write`  | `{id, bytes: number[]}`               | `null` after the write               |
| `console.resize` | `{id, cols, rows}`                    | `null`                               |
| `console.close`  | `{id}`                                | `null` after cleanup                 |

Bytes are integers from 0 through 255, preserving binary console data and split UTF-8 sequences. Read/write chunks are at most 64 KiB. An empty read with `closed: false` is a poll timeout; empty with `closed: true` is EOF. Output may accompany EOF; the next read must also return EOF. Sizes use the existing terminal bounds (2–500 columns, 2–300 rows). Resize is exposed only when the method is advertised and the particular open reports it supported.

The host chooses a fresh UUID before opening. `console.close` must retire even a pending/unknown open ID; late setup must release its resources rather than revive that ID. A canceled open sends cleanup using the already-known ID. Closing one console cannot disconnect another console sharing the process. The two stream halves retain shared ownership; dropping both starts cleanup. Explicit close preserves its once-only outcome for later callers. A pending read may run alongside a write. Standard calls have a 30-second deadline; console close has a three-second deadline. Failed/uncertain writes and close are not repeated automatically.

## Verification and next integration

```powershell
cargo test -p shellcanvas-adapter-runtime --locked
cargo clippy -p shellcanvas-adapter-runtime --all-targets --locked -- -D warnings
```

The tests compile and launch `fixture-adapter` as a separate executable. They cover version/catalog rejection, oversized/malformed output, process exit, out-of-order/late replies, cancellation, concurrency capacity recovery, shared close results, independent processes, 20,000 paged file entries, opaque locations, binary consoles, simultaneous read/write, fixed-size consoles and abandoned-open cleanup. These are real local processes with fake device data, not in-process service mocks or tests of a live remote protocol. The fixture binary is test scaffolding, not an adapter to install in production.

Reviewed packages and configuration UI connect these service objects to production workspace composition and independent source replacement. Separate-process tests cover text/settings revisions, read-only methods, file relocation mappings and malformed write replies without breaking unrelated services. Eight transfer tests cover binary copies, 20,000-entry traversal, open/stream cancellation, cleanup capacity, directional support, stale sources, no-clobber publication and malformed replies. Selected [custom services](custom-services.md) route to installed apps with explicit grants and connection ownership. Next steps include a standalone adapter SDK/schema/starter and cross-platform process evidence. The full [kernel roadmap](kernel-roadmap.md) remains active.
