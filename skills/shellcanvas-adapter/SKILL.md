---
name: shellcanvas-adapter
description: Implement a ShellCanvas connection or device adapter, including SSH alternatives, serial, file protocols and custom APIs, through versioned service contracts. Use for device access implementations rather than desktop app UI.
---

Locate the ShellCanvas checkout through `crates/adapter-sdk`. Read
[the adapter SDK guide](../../docs/adapter-sdk.md) and
[the process/service contract](../../docs/adapter-process.md). Use the user's
chosen device/protocol. A synthetic echo demonstrates the runtime contract; it
does not count as implementing a real protocol.

## Choose the services

Expose only supported service families. Files, console, remote settings and
namespaced custom services can come from different connections in a workspace.
Files methods must share one coherent location/revision namespace. Do not assume
that a file path maps to a console path, or inject detection commands into an
interactive serial/Telnet session. Optional capabilities should stay unavailable
with their reason while supported tools remain usable.

For a normal desktop feature, implement its documented standard service. For a
vendor-specific operation, declare a namespaced custom service and version; a
new kernel method is not required. A device provider can interpret responses
within the adapter; apps should not need OS/protocol branches. Read
[composition](../../docs/connections.md) when combining sources.

## Start an independent adapter

Build `shellcanvas-adapter` from an exported SDK source directory. Its
[command reference](../../crates/adapter-sdk/README.md) describes dependencies.
With the CLI on PATH, resolve these paths and run:

```sh
shellcanvas-adapter init DEVICE_DIR --id org.example.device --name "My device" --sdk-source SDK_SOURCE_DIR
shellcanvas-adapter build DEVICE_DIR NEW_PACKAGE_DIR --debug
shellcanvas-adapter validate NEW_PACKAGE_DIR/adapter.json
```

For standard services append `--template files`, `--template console` or
`--template settings` after `--sdk-source SDK_SOURCE_DIR`. The defaults remain
custom echo/wait. Files demonstrates read-only paged inventory and opaque
locations; console demonstrates cancelable byte loopback and independent
session cleanup; settings demonstrates revision-checked updates and readback.
Each generated README names the workspace role to assign. Do not claim these
synthetic examples implement the user's actual protocol.

Replace the generated service with the user's device implementation. Configuration
belongs in the manifest's typed fields; use password fields for secrets and no
secret defaults. Initialize from the configuration message, not process args.
Rust adapters can implement `Adapter::initialize` and `Adapter::call`; other
languages may implement the same wire contract and use the CLI to package their
executable. No desktop rebuild should be needed to load the new adapter.

## Preserve operational behavior

The SDK handles framing and concurrent request dispatch. Protect shared device
state without blocking console writes behind a waiting read. Observe each
request's cancellation context, clean up, and return the authoritative outcome.
Use RAII cleanup as well because the host can terminate the process. stdout is
reserved for the protocol; logs/errors must not expose credentials.

Use provider-owned revisions for writes and no-clobber publication where the
standard contract requires it. Transfers use bounded chunks and incremental
directory readers, not whole-tree arrays or arbitrary total-entry caps. A canceled
open/abort must not resurrect a retired resource. Cancellation cannot undo an
already completed write. Never silently retry mutations or substitute endpoints.

Native adapters execute with the user's OS permissions. App UI grants do not
sandbox adapter network/device access; keep that distinction in documentation.

## Verify

Inspect [connection diagnostics](../../docs/adapter-diagnostics.md) for startup,
request and cleanup observations. Reports omit payloads and raw adapter messages;
do not infer a mutation's authoritative outcome from cancellation or a deadline.
Retained history must not keep a process or package generation alive.

Test the implemented protocol with representative fixtures, including unsupported
services, errors, cancellation and cleanup. `npm run verify:adapter-sdk` proves
independent export, generation, packaging and production-host interoperability
for all four synthetic starters. The [adapter package guide](../../docs/adapter-packages.md)
documents the Windows install/connect/replacement fixture. Follow it for runtime
integration; use a real device only within the user's authorized scope. Report
which device/version, platform and failure paths were actually exercised.
