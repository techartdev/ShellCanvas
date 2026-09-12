---
name: shellcanvas-adapter
description: Implement a ShellCanvas connection adapter in Rust or any language, exposing a device or protocol through versioned service contracts so workspaces gain files, a console, settings or custom methods. Use for device access, not for desktop app UI.
---

An adapter is a native process the desktop launches and talks to over stdin and
stdout. It decides what a connection can do by advertising services; the desktop
enables exactly those roles and shows the rest as unavailable.

The SDK and its CLI are published, so nothing here needs a ShellCanvas checkout:

```sh
cargo install shellcanvas-adapter-sdk     # installs the shellcanvas-adapter CLI
```

```toml
# Or just depend on it, and write the adapter yourself.
[dependencies]
shellcanvas-adapter-sdk = "0.1.0"
tokio = { version = "1", features = ["macros"] }   # only for tokio::select!
```

**`shellcanvas-adapter init` requires `--sdk-source` pointing at a local copy of
the SDK crate, which a developer without a checkout does not have.** Do not send
the user hunting for one. Either write the small project by hand against the
crates.io dependency above, or generate with `--sdk-source` and then delete the
`path = …` key from the generated `Cargo.toml` so it resolves from crates.io.
`pack`, `validate` and `schema` need no SDK source at all.

Reference: <https://shellcanvas.com/docs/adapter-sdk/quickstart.html>

## Advertise only what the device can honour

`initialize` returns a service catalog, and that catalog is fixed for the life of
the connection. A role appears in the desktop only when its exact service,
version and full method set are present.

| Desktop role | Service | Required methods |
| --- | --- | --- |
| Files browsing | `files` v1 | `files.list`, `files.locate`, `files.preview` |
| Opening text | `files` v1 | `files.readText` |
| Create/rename/delete | `files` v1 | `files.makeDirectory`, `files.rename`, `files.remove` (all three) |
| Downloads | `files` v1 | `files.download.open/read/finish` + `files.transfer.abort` |
| Terminal | `console` v1 | `console.open`, `console.read`, `console.write`, `console.close` |
| Remote settings | `host` v1 | `host.settings.read`; add `host.settings.apply` to allow changes |

Partial support is normal and better than failing late: omit `files.saveText`
and documents open read-only; omit `host.settings.apply` and settings render
read-only. Anything else you expose is a custom service, named like a domain you
own (`com.example.thermostat`), reachable by apps holding `services.<id>`.

A synthetic echo proves the runtime contract and nothing about a real protocol.
Do not describe it as device support.
<https://shellcanvas.com/docs/adapter-sdk/services.html>

## Implement initialize and call

Two methods carry the whole adapter. Configuration arrives in the initialize
message — never as process arguments — and every call gets a cancellation
context.

```rust
// Everything comes from the SDK, including async_trait and serde_json.
use shellcanvas_adapter_sdk::{
    async_trait, json, run, Adapter, CallError, RequestContext, ServiceDescriptor, Value,
};

struct Device;

#[async_trait]
impl Adapter for Device {
    async fn initialize(
        &self,
        configuration: Value,
        _context: RequestContext,
    ) -> Result<Vec<ServiceDescriptor>, CallError> {
        configuration
            .get("endpoint")
            .and_then(Value::as_str)
            .ok_or_else(|| CallError::new("invalid", "Configure the device address"))?;
        Ok(vec![ServiceDescriptor {
            id: "com.example.thermostat".into(),
            version: 1,
            methods: vec!["com.example.thermostat.read".into()],
        }])
    }

    async fn call(
        &self,
        method: &str,
        _params: Value,
        context: RequestContext,
    ) -> Result<Value, CallError> {
        match method {
            "com.example.thermostat.read" => tokio::select! {
                _ = context.canceled() => Err(CallError::new("aborted", "Canceled")),
                reading = self.read() => reading,
            },
            _ => Err(CallError::new("unavailable", "Unknown method")),
        }
    }
}

impl Device {
    async fn read(&self) -> Result<Value, CallError> {
        Ok(json!({ "celsius": 21.5 }))
    }
}

fn main() -> std::io::Result<()> {
    run(Device)   // owns the runtime, and speaks the protocol on stdin/stdout
}
```

Error codes are fixed: `invalid`, `closed`, `aborted`, `denied`, `unavailable`,
`busy`, `failed`, `deadline`. Use `unavailable` when the operation does not exist
here and `denied` when it exists but is refused.

## Respect the protocol's hard edges

The SDK owns framing and dispatch, but a few limits will end a connection if you
ignore them, and one of them is easy to hit by accident.

**stdout is the protocol.** Anything printed there corrupts a frame and drops
the connection. Standard error is discarded by the host, so an adapter that
needs logs must write its own file. This is the single most common cause of an
adapter that starts and immediately dies.

Frames cap at 4 MiB, 32 requests may be in flight, calls deadline at 30 seconds,
and replies may arrive out of order. Page or chunk large results rather than
sending a tree in one message. Reply `busy` instead of queueing without bound.

Concurrency is real: a waiting console read must not hold a lock that a write or
Concurrency is real: a waiting console read must not hold a lock that a write or close needs. Observe `context.canceled()`, release resources, and return the authoritative outcome — a cancelled handler keeps its slot until it returns.
authoritative outcome — a cancelled handler keeps its slot until it returns.
<https://shellcanvas.com/docs/adapter-sdk/protocol.html>

## Never let cancellation invent an outcome

Cancellation, a deadline and a dropped pipe all mean "we stopped waiting" — none
of them means the device did not act.

A completed write stays completed. A cancelled open must not resurrect a retired
handle. Do not silently retry a mutation, and do not substitute a different
endpoint when one fails. Where the result is genuinely unknown, say so and let
the layer above decide; the desktop is built to report uncertainty rather than
guess.

Use provider-owned revisions and no-clobber publication wherever the standard
file contract requires it, and implement RAII cleanup as well as graceful
shutdown — the host can terminate the process without a grace period.

## Package the executable

Packaging hashes every file and needs no SDK source, so it works the same for a
Rust adapter and for one written in any other language.

```sh
cargo build --release
shellcanvas-adapter pack ./adapter.json ./target/release/my-device ./dist/my-device-0.1.0
shellcanvas-adapter validate ./dist/my-device-0.1.0/adapter.json
```

`shellcanvas-adapter schema source` prints the manifest schema. Identifiers are
namespaced and must not start with `system`; configuration fields are typed, and
a `password` field may not carry a packaged default. Package the whole output
directory, not just its JSON.

The desktop re-verifies every hash before it launches the process, so a modified
file after review is refused.
<https://shellcanvas.com/docs/adapter-sdk/packaging.html>

## Be honest about trust and verification

A native adapter runs with the user's operating-system permissions. App UI grants
do not sandbox it, package hashes establish what you installed and never who
wrote it, and there is no signing or review.

Say that plainly in your own documentation rather than implying the desktop
vets adapters.

Test the protocol you implemented with representative fixtures: unsupported
methods, errors, cancellation, cleanup, and a connection that drops mid-call.
When something fails at runtime, **App Manager → Connection adapters →
Connection diagnostics → Copy report** gives a redacted host-side timeline that
is safe to attach to an issue. Report which device, firmware and platform you
actually exercised — synthetic fixtures prove the contract, not the device.
<https://shellcanvas.com/docs/adapter-sdk/diagnostics.html>
