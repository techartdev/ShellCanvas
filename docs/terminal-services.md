# Terminal service boundary

The native desktop opens consoles through `TerminalService`, not through an SSH channel. `TerminalService`, `TerminalStream`, byte reader/writer traits, dimensions and IPC events live in `shellcanvas-services`, which has no SSH, SFTP, Tauri or async-runtime dependency. The SSH adapter implements that contract; additional protocols are not implemented yet.

Each open returns independently owned reader/writer halves. Incoming bytes remain bytes until xterm decodes them. A console can declare itself non-resizable; the pump skips resize messages while keeping input/output available. For resizable consoles, dimensions are clamped to 2–500 columns and 2–300 rows. Native event serialization is unchanged.

The connection-neutral pump in `src-tauri/src/terminals.rs` reads and writes concurrently. An input blocked by remote backpressure does not stop output or cancellation. Inputs are serialized with a 15-second deadline per write/resize; no partially delivered input is retried. A 128-message input queue and 64 KiB chunk limit bound queued input. Providers must bound their reads too. The current IPC output callback does not acknowledge renderer consumption; sustained-output throughput/backpressure remains a separate integration concern.

The session registry owns a cancellation sender for each terminal. Removing a window or session drops that owner and stops the pump even when an in-flight IPC call retains an input sender. After I/O futures stop, cleanup gets a three-second bound and the pump emits one Closed event. Error exits first emit Error. The SSH writer also attempts bounded cleanup when an already-open stream is abandoned before registration. Connection negotiation cancellation remains covered by its existing timeout/cancellation path; cancellation at every SSH negotiation phase is not claimed here.

## Verification

- Runtime fixtures cover output during blocked input, explicit close with a retained input handle, split multibyte output, independent consoles, non-resizable consoles, dimension clamping, invalid chunk sizes and provider read/write errors. Cleanup runs once in those fixtures.
- Registry checks preserve ownership across session removal and reject stale/cross-session input.
- `cargo run -p shellcanvas --example terminal_probe -- HOST USER KEY_PATH` exercises the production SSH terminal adapter, native pump and registry. It opens two shells, uses only temporary shell variables and terminal-size queries, closes one while retaining its input handle, verifies the other still responds, then closes both and disconnects. It does not print credentials or remote terminal contents.
- The authorized `root@evtinsait` run passed independent variables, 120×40 and 90×25 dimensions, survivor input/output, stale/cross-session refusal and cleanup. This is a native Rust integration probe, not a Windows GUI clipboard/keyboard walkthrough or a physical serial test.

Connection identity/lifecycle contracts, composite service bindings, connector-specific settings and per-binding availability remain open. No automatic fallback from SSH to an insecure protocol is introduced.
