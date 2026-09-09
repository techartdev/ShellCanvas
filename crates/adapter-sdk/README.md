# ShellCanvas Rust adapter SDK

Build a native connection adapter by implementing `Adapter::initialize` and
`Adapter::call`, then pass it to `run`. This crate has no ShellCanvas desktop,
Tauri, SSH or repository path dependencies. Version 0.1.0 is provisional and is
not published to crates.io. Use a supplied SDK source archive until publication.

The `examples/echo.rs` program implements a synthetic custom service and a
cancelable wait with this SDK alone. Build it with `cargo build --example echo`.
Its executable can be packaged as a native adapter; it does not contact a real
device. A separately compiled example is exercised against the production host
in the repository's adapter-runtime integration tests.

The SDK owns protocol framing, version negotiation, service catalog validation,
concurrent dispatch, cancellation signals, bounded queues and pipe teardown.
The desktop and SDK share the same wire definitions. Arbitrary device services
use namespaced methods; standard services follow the desktop's files/console/
settings contracts. Only advertise methods that the device can support.

`initialize` receives configuration through the pipe, never command arguments.
Store device state in your adapter using appropriate synchronization. Calls run
concurrently: a waiting console read must not hold a lock needed by a write or
close. Each `RequestContext` has an ID and a cancellation signal. Observe
`context.canceled().await` or `context.is_canceled()`, release resources and
return the authoritative outcome. Cancellation cannot undo a completed write.
Use revision checks and no-clobber publication for the standard file contract.

There are 32 active request slots. A canceled handler retains its slot until it
finishes; cancellation does not allow unlimited abandoned work. Replies may
arrive out of order. The output queue has 64 frames and pipe writes time out
after ten seconds; an unresponsive host closes the connection. Frames have a
4 MiB ceiling; bulk operations page/chunk rather than sending an entire tree or
file. Total streamed files/bytes are not capped.

On pipe close or protocol failure, active contexts receive cancellation and have
up to five seconds to finish. Dropping `serve` aborts owned tasks. Implement RAII
cleanup as well: the desktop can terminate the process without this grace
period. Do not launch unmanaged child processes. Adapter packages execute with
the user's OS permissions and are not sandboxed by app UI grants.

Reserve stdout exclusively for the protocol. Return credential-free `CallError`
messages with codes `invalid`, `closed`, `aborted`, `denied`, `unavailable`,
`busy`, `failed` or `deadline`. Unsupported methods are rejected before calling
your implementation. Never put passwords in logs or public error messages.

`serve(adapter, reader, writer)` supports an existing Tokio runtime and test
streams. `wire` is public for implementations in other languages and contract
harnesses; this does not turn untrusted input into trusted device operations.

Standalone generators, manifest schemas, packaging commands and desktop
installation examples are still being developed. This crate is the shared
protocol/server foundation, not the completed adapter developer kit.
