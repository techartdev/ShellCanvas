# ShellCanvas Rust adapter SDK

Build a native connection adapter by implementing `Adapter::initialize` and
`Adapter::call`, then pass it to `run`. This crate has no ShellCanvas desktop,
Tauri, SSH or repository path dependencies. Version 0.1.0 is published on
crates.io and remains provisional.

## Generate, build and validate an adapter

Add the SDK to a project with `shellcanvas-adapter-sdk = "0.1.0"`, and install
the CLI from the same crate:

```sh
cargo install shellcanvas-adapter-sdk
```

That provides `shellcanvas-adapter` on PATH. It requires Rust/Cargo to build Rust
adapters; it does not require Node, the desktop source tree or a device
connection. Building from a checkout also works: `cargo build --bin
shellcanvas-adapter --locked`, then use `target/debug/shellcanvas-adapter`.

```sh
shellcanvas-adapter init ./my-device --id org.example.device --name "My device" --sdk-source /absolute/path/to/sdk-source
shellcanvas-adapter build ./my-device ./my-device-package --debug
shellcanvas-adapter validate ./my-device-package/adapter.json
```

Omit `--debug` for a release build. Parent directories must already exist; the
project and package output must be new directories. Builds reuse `Cargo.lock`
once created. `init` still requires `--sdk-source`, and writes a `path`
dependency on that directory; delete the `path` key from the generated
`Cargo.toml` to consume the published crate instead. `pack`, `validate` and
`schema` need no SDK source at all. By default the starter exposes a custom echo
service under your chosen ID. Append `--template files`, `--template console` or
`--template settings` after `--sdk-source SDK_DIR` for a standard service:

- `files`: 300 read-only notes with opaque locations and stateless,
  revision-bound pages. No writes or transfers are advertised.
- `console`: concurrent byte loopback sessions with cancellation, bounded output
  queues and idempotent retirement. No shell commands run; resize is unsupported.
  Closed identities remain retired until process exit. When replacing synchronous
  open with device setup, reserve before awaiting, then recheck retirement and
  release late resources before returning.
- `settings`: a synthetic mode field with revision-checked updates and verified
  readback. State resets on reconnect. Real devices need their own comparison,
  commit and confirmation semantics.

These same runnable sources live in `examples/files.rs`, `examples/console.rs`
and `examples/settings.rs`; `cargo build --examples` builds them with the SDK
alone. The generated console project declares its Tokio dependency explicitly.
Choose the generated role in workspace composition; missing roles stay disabled.

Open ShellCanvas's Apps → Connection adapters → Install adapter and select the
package's `adapter.json`. Review native-code trust. Add the installed source in
the connection editor and select its service ID under Additional services. An
app that requests `services.<service-id>` can consume its methods. Updates use a
new manifest version and output directory; existing connections keep their old
generation until explicit replacement or reconnect.

`shellcanvas-adapter pack SOURCE_JSON EXECUTABLE NEW_OUTPUT [--version VERSION]`
packages an already-built executable, including implementations in other
languages. `platform: "current"` and `{exe}` in source paths expand to the
tool's host platform. Assets are streamed into the new output and hashed; the
manifest is written last. A failed pack can leave an incomplete output directory;
retry into a fresh directory. `validate` checks metadata and every asset hash
without executing anything. The desktop uses the same manifest validator and
independently verifies the assets again before installation and connection.

Editor schemas are in `schemas/adapter-source.schema.json` and
`schemas/adapter-package.schema.json`, also printable with `schema source` or
`schema package`. They describe structure; CLI validation additionally enforces
byte lengths, reserved filenames, unique IDs/paths, semver and file hashes.
Credentials must not appear in source files or packaged password defaults.

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

The repository's `npm run verify:adapter-sdk` exports this SDK and builds,
packages and validates all four generated variants outside the checkout, then
exercises them through the production adapter host. The custom-service workflow
also has Windows desktop installation evidence. The repository distributes AI development skills for apps,
adapters and packaging. Actual device protocols and
non-Windows native verification are not established by the synthetic examples.
