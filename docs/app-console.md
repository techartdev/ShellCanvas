# Runtime app consoles

Installed apps use `client.console` with the `system.console` permission. The separate device capability is `terminal`. Each console is an independently owned byte stream on the window's accepted workspace binding. It may be an SSH shell, serial device, or another provider-defined channel. The API does not interpret commands, line endings, or escape sequences.

```ts
const { binding } = await client.environment.get();
if (!binding) throw new Error("Connect to a workspace first.");
const controller = new AbortController();
const channel = await client.console.open(
  { binding, cols: 80, rows: 24 },
  controller.signal,
);
try {
  const output = (async () => {
    for (;;) {
      const bytes = await channel.read();
      if (bytes === null) break;
      await consumeBytes(bytes);
    }
  })();
  await channel.write(new Uint8Array([0x03]));
  if (channel.resizable) await channel.resize(120, 40);
  await output;
} finally {
  await channel.close();
}
```

`open({binding, cols?, rows?}, signal?)` defaults to 80 columns and 24 rows. Dimensions must be integers in 2–500 columns and 2–300 rows. `resizable` describes the opened console. Fixed-size consoles retain full I/O and reject resize with `unavailable`.

`read(signal?)` returns up to 64 KiB as a `Uint8Array`, or `null` at EOF. Provider errors reject with `failed`; they are not converted to EOF. Keep decoder state across chunks when interpreting text. `write(bytesOrText, signal?)` captures its input and sends chunks of at most 64 KiB. Strings use UTF-8; byte arrays preserve every value. Empty writes still validate permission and lifetime. Read and write concurrently. Await writes to preserve whole-write ordering; overlapping writes return `busy` rather than interleaving their chunks.

## Flow control and lifecycle

The native pump permits one unacknowledged output chunk. The desktop acknowledges after the consumer accepts it: runtime apps consume it through `read`, and bundled Terminal uses xterm's write callback. A paused reader holds bounded output instead of dropping bytes or accumulating unbounded messages. Input and cancellation continue independently. There is no total stream-size limit; remote devices and protocol libraries may maintain their own buffers.

Aborting the signal passed to `open` closes that console, including a pending open. Aborting an individual read/write/resize also closes it: bytes may already have crossed the RPC boundary, so cancellation cannot promise that nothing happened. Do not reuse canceled channels or retry uncertain input automatically. `close()` is idempotent in the SDK and requires no still-available terminal capability.

Each window can own 16 consoles, including pending opens, unfinished calls, and cleanup. Only one read, one write, and one resize may be pending per console. Unconfirmed cleanup remains charged to that window instead of permitting unbounded replacement resources. These are simultaneous-resource limits, not byte-count limits. A provider that ignores output flow control fails explicitly. Closing one console leaves other consoles usable.

Disconnection, source replacement, capability loss, frame teardown, and channel disposal retire affected handles. Accepting a new binding does not retarget an old console; explicitly open a new one. Native session IDs and handles never enter the public API. Separate windows cannot control one another's consoles.

## Verification

`src/extensions/console-bridge.test.ts` exercises the actual SDK/RPC path with synthetic providers: binary preservation, chunking, independent consoles, paused reads, EOF/errors, cancellation, permissions, ownership, source replacement, pending-open accounting, and fixed-size channels. Native pump/registry tests cover ordered output acknowledgements, cross-session refusal, and paused output with surviving input and prompt cancellation.

The Windows adapter fixture builds the SDK outside the repository and transfers binary data through an installed app frame, broker, native pump, and separately running synthetic adapter. It also exercises bundled Terminal on the same transport. It uses no real host or OS clipboard. Passing this fixture does not establish throughput targets or physical serial-device support.
