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
schemas and custom, Files, console and Remote settings starters. It supports `init`, `build`, `pack`,
`validate` and `schema`. See the [SDK command guide](../crates/adapter-sdk/README.md)
for exact commands. Package identity/configuration/path validation now lives in
the SDK and is reused by the desktop, so tools and installation share its rules.
The repository's old JavaScript packer delegates to this CLI.

The independent verifier also builds the CLI, generates a project outside the
checkout, compiles/packages it and checks its executable with the production
host. Source/package schemas are checked against exported artifacts and invalid
fields/defaults. Four tooling tests cover binary assets, preserving existing
projects/packages, unknown templates, tampering, bad metadata and password defaults. Neither schema
validation nor packaging executes the device; building intentionally compiles
the chosen source and its dependencies.

The 68-check Windows desktop fixture installs this generated package through its
review UI, creates a custom-service-only workspace, calls the generated process,
and verifies that removing its package preserves the live connection. The native
file chooser is replaced with the verified fixture path. This is runtime package
installation evidence on Windows, not support for a real device protocol.

## Standard-service starters

Append `--template files`, `--template console` or `--template settings` after
`--sdk-source SDK_DIR` when running `init`. Omission selects `custom` and keeps
the existing echo/wait workflow. Each variant is a complete, independent project
using the exported SDK; its README explains the workspace role to assign.

| Template   | Demonstrates                                                                                                                            | Deliberately unavailable                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `files`    | 300 immutable notes, bounded pages, stateless revision-bound cursors, opaque locations, read-only text                                  | Writes, transfers, console and settings     |
| `console`  | Independent byte loopback sessions, concurrent read/write, cancellation, bounded queued output, idempotent close and retired identities | Shell execution, resize, files and settings |
| `settings` | Discoverable select field, atomic revision comparison and update, authoritative readback, concurrent-edit refusal                       | Files and console                           |

These are synthetic services, not implementations of SSH, serial or a vendor
API. The console retains retired identities for its process lifetime so late
opens cannot revive them. It bounds active sessions and queued output separately.
For asynchronous device setup, reserve an identity before awaiting and recheck
retirement before publishing resources. Real settings need device-side conflict
and confirmation semantics; the example's state resets on reconnect.

`npm run verify:adapter-sdk` generates, builds, packages and validates all four
templates outside the checkout. Six standard-service tests launch the exact
example sources in ordinary Rust verification and the generated executables in
the export workflow. They exercise the production Files/text, Terminal and
Settings bridges, partial capability discovery, paging and stale cursors,
concurrent settings writes, binary console data, cancellation, output bounds,
close-before-open, independent sessions and session capacity recovery after
dropping both console halves. This proves process interoperability;
it does not claim native GUI installation of every standard variant or a live
device protocol. Remaining lifecycle/platform gates stay in the
[kernel roadmap](kernel-roadmap.md). [AI development skills](ai-development-skills.md)
describe how to choose and replace these synthetic services.
