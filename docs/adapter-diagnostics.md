# Adapter connection diagnostics

Open **App Manager → Connection adapters → Connection diagnostics** to inspect recent
installed native adapter connections. The same panel is available after a
connection error. Expand it, choose a connection, use **Refresh** for new events,
or **Copy report** to put a JSON report on the clipboard. Opening or refreshing
the panel does not reconnect, retry work or keep an adapter running.

The desktop retains at most 32 connection histories across its native windows
for the current app run. Each history retains its newest 256 events and reports
how many earlier events were discarded. Closing an adapter or removing its
package does not immediately remove its history; older histories are evicted
when new attempts arrive. Restarting the desktop clears all histories. These
are diagnostic retention bounds, not limits on files, transfers or operations.

## Report contents and ownership

Schema version 1 reports the package identifier, connection instance/generation,
connection attempt, current observed status and event timeline. Each event has
a sequence number, elapsed milliseconds, a fixed host-defined event category,
and optional protocol request ID and approved error code. Package identifiers
are validated and bounded before retention; invalid identifiers use
`unknown-adapter`. An attempt can contain several independently identified
adapter sources.

Observations include package preparation failure/cancellation, process launch,
initialization, dispatched requests and replies, cancellation/deadlines, late
replies, protocol/pipe failures, close and cleanup confirmation. An individual
request failure does not mark an otherwise working connection failed. Cleanup
confirmation does not erase a preceding failure. Some observations, including
deadline expiration, have no request ID. The report is a bounded host timeline,
not an exhaustive audit log or proof that a remote mutation did or did not occur.
Inspect uncertain mutations before retrying; cancellation is not undo.

The host never retains configuration, launch arguments, executable paths,
method names, request/response values, adapter error messages, stdout or stderr
in this history. Consequently, reports do not contain file contents or console
output. Package identifiers and connection metadata are included deliberately.
Raw adapter stderr is not an alternative log captured by this feature.

The native command returns only histories owned by its calling desktop window.
Installed app frames cannot invoke it through native IPC, and the public app
broker does not expose it as a grant. This feature covers installed native
adapters; built-in SSH and arbitrary app logs are outside its scope. Histories
are in memory, with no background upload or persistent log file.

## Host integration

The production runtime exports `Diagnostics`, `DiagnosticSnapshot` and typed
event/status/code enums. Create a fresh `Diagnostics::default()` for each launch,
retain a clone, and pass the original to `AdapterProcess::launch_observed` or
`PackageLease::connect_observed`. The retained clone can inspect failed or
canceled initialization through `snapshot()` even when no process was returned.
`AdapterProcess::diagnostics()` reads the same history for an existing process.
The ordinary launch/connect methods also create a history internally.

A diagnostics handle owns only its bounded observations; it never owns the
process, installed asset generation or catalog lease. Reusing a handle for
another launch is rejected. Desktop integration registers the history before
package acquisition and uses `preparation_failed()` / `preparation_canceled()`
for attempts that end before launch. Once launch claims the handle, preparation
cleanup cannot overwrite its state. No adapter protocol change is required.

## Verification

`cargo test -p shellcanvas-adapter-runtime --test diagnostics --test catalog --locked`
launches real fixture processes. It covers payload/configuration/error-message
exclusion, failed and canceled startup, bounded history and independent
connections, late replies, malformed output and cleanup with a retained history.
Catalog coverage verifies that retaining diagnostics does not retain assets.
Native unit coverage checks window ownership and registry eviction.

The [Windows desktop fixture](adapter-packages.md#native-integration-evidence)
also exercises a missing package attempt, reads its failure through native IPC,
opens the panel and exports its report, while preserving an existing connection.
Its clipboard writer is injected; this is not a live OS clipboard test. Browser
visual checks cover selecting, refreshing and exporting a full 256-event history.
Non-Windows runtime and UI evidence remains in the [kernel roadmap](kernel-roadmap.md).
