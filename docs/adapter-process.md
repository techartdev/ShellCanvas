# Native adapter process contract (provisional v1)

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

Paths, parent locations, roots and cursor tokens remain opaque. The host does not split/join/normalize them or send them to a different service source. The compatibility bridge collects pages for the current browser's materialized `Directory` result, with a 30-second operation deadline. It is not a constant-memory directory UI. The separate existing recursive transfer engine remains incremental; its process-adapter transfer bridge is still required. There is no new total-entry count limit.

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

Reviewed packages and configuration UI connect these service objects to production workspace composition and independent source replacement. Selected [custom services](custom-services.md) route to installed apps with explicit grants and connection ownership. Next steps include text/mutation/transfer/settings bridges, a standalone adapter SDK/schema/starter and cross-platform process evidence. The full [kernel roadmap](kernel-roadmap.md) remains active.
