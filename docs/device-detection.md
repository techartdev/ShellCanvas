# Device detection

`HostInfo`, `CommandProbe` and `ProbeContext` live in the transport-independent `shellcanvas-services` crate. Existing imports through `shellcanvas-core` remain available. A connector supplies fallback identity/capabilities and, optionally, independent command probes. A console is not a command-probe service: detection never types commands into an interactive terminal.

`inspect_with_providers` checks trusted providers in registration order within one total time budget. A failed inspection continues to the next provider. Unknown, missing-command, failed and timed-out detection retains the connection's fallback information and tools, with an explanatory notice. Detecting Linux does not manufacture terminal or file capabilities.

Each call creates its own probe cache. Providers share results for the exact command string during detection and inspection, including failed requests. Concurrent requests for the same command share one in-flight result; unrelated commands do not hold a shared lock across network waits. Nothing is cached across hosts, calls or reconnects. Administrative settings use fresh commands outside this cache.

The cache accepts at most 64 distinct commands, 4 KiB per command and 64 KiB per returned output/error. Reaching a limit produces a probe failure rather than growing storage or retrying an oversized response. The underlying implementation must still bound its own output and time; the cache cannot prevent a provider from allocating memory before returning. Cancellation drops the pending inspection future; there is no background probe task detached from that attempt.

## Scope and checks

Tests cover recognized Linux, unknown systems, no-exec connections, command failures, failed inspection followed by a later provider, total timeout, overlapping success/failure requests, per-attempt isolation and cache bounds. The SSH adapter remains the only production connector, with Linux the only recognized system provider. Composition, additional operating systems, per-service availability and contributor packaging remain separate work.
