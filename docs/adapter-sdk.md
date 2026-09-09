# Rust adapter SDK

The provisional `shellcanvas-adapter-sdk` crate supplies the adapter side of the
versioned process protocol. It has no dependency on the desktop, Tauri, SSH or
other workspace crates. The host re-exports the same framing and service
descriptor definitions, avoiding two independently maintained wire formats.

Implement the asynchronous `Adapter` trait:

- `initialize(configuration, context)` opens the device and returns its supported
  service descriptors. Credentials arrive in configuration through stdin.
- `call(method, params, context)` performs an advertised operation. Calls are
  concurrent, so a waiting console read must permit input and cancellation.
- `run(adapter)` owns the process runtime and stdin/stdout protocol; `serve` can
  instead use an existing Tokio runtime or test streams.

The SDK validates negotiation, service names and request identities, dispatches
only advertised methods, and supplies per-request cancellation. It limits active
requests and pipe queues, not the total number of files or bytes. Cancellation
remains cooperative: a handler keeps its request slot until it finishes cleanup.
The adapter implements actual device semantics, revision checks and publication
rules. Read [the wire contract](adapter-process.md) before implementing standard
Files, Terminal or Remote settings services.

The [SDK README](../crates/adapter-sdk/README.md) explains resource ownership,
errors and termination. The [echo example](../crates/adapter-sdk/examples/echo.rs)
is a small custom-service adapter with concurrent echo and cancelable wait
operations. It requires no device or credentials. Native adapter programs have
the user's OS permissions; this SDK is not a sandbox.

## Independent build verification

With Rust, Cargo, Node and `tar` installed, and the locked dependencies cached:

```sh
npm run verify:adapter-sdk
```

The command exports a Cargo source archive, extracts it into a new temporary
directory outside the checkout, builds its echo executable using only that
archive and registry dependencies, and launches the executable through the
production adapter host. It checks concurrent binary/Unicode JSON echo,
cancellation without connection retirement, and process exit after invalid input
while stdin remains open. It leaves its temporary directory for inspection and
writes `.local/adapter-sdk-verification/latest.json`. Export permits a dirty
checkout so the report proves the exported source, not an unstated commit.
Nothing is published to a registry or installed into the user's adapter catalog.

Five SDK contract tests cover cancellation and capacity recovery, partial-frame
interleaving, unsupported methods, malformed negotiation/catalogs, replayed IDs,
invalid error normalization, clean EOF and truncated frames. The two production
host/process tests also run in `cargo test --workspace --locked`. The normal
verification includes those tests and lint; the separate export command proves
independent consumption of the archive.

## Standalone tooling

The SDK now includes the native `shellcanvas-adapter` CLI, public source/package
schemas and a custom-service starter. It supports `init`, `build`, `pack`,
`validate` and `schema`. See the [SDK command guide](../crates/adapter-sdk/README.md)
for exact commands. Package identity/configuration/path validation now lives in
the SDK and is reused by the desktop, so tools and installation share its rules.
The repository's old JavaScript packer delegates to this CLI.

The independent verifier also builds the CLI, generates a project outside the
checkout, compiles/packages it and checks its executable with the production
host. Source/package schemas are checked against exported artifacts and invalid
fields/defaults. Three tooling tests cover binary assets, preserving existing
projects/packages, tampering, bad metadata and password defaults. Neither schema
validation nor packaging executes the device; building intentionally compiles
the chosen source and its dependencies.

The 68-check Windows desktop fixture installs this generated package through its
review UI, creates a custom-service-only workspace, calls the generated process,
and verifies that removing its package preserves the live connection. The native
file chooser is replaced with the verified fixture path. This is runtime package
installation evidence on Windows, not support for a real device protocol.

Standard-service starter variants, AI development skills and remaining
lifecycle/platform gates are still required. Actual device implementations are
separate from the generated synthetic custom service.
