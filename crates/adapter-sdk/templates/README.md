# Your ShellCanvas adapter

This generated Rust project uses the separately supplied SDK source directory.
Keep that directory available, or update the Cargo dependency when an official
SDK release is published. The starting custom service echoes JSON and supports
a cancelable wait. It does not contact a device.

Implement your device connection in `src/main.rs`, add public configuration
fields to `adapter.json`, and advertise only supported service methods. Password
fields use `kind: "password"`; never package defaults or real credentials.
Standard Files, Terminal and Remote settings use their versioned contracts.
Applications consume those services without knowing the device protocol.

Build and package into a new directory (its parent must exist):

```sh
shellcanvas-adapter build . ../my-adapter-package
shellcanvas-adapter validate ../my-adapter-package/adapter.json
```

Use `--debug` after the output argument for a debug build. Existing outputs and
projects are never overwritten. A failed package may leave an incomplete output
directory; retry with a new destination. The manifest is written last.

In ShellCanvas, open Apps → Connection adapters → Install adapter, choose the
package's `adapter.json`, and review native-code trust. In the connection editor,
add the installed adapter and assign its custom service ID under Additional
services. It has no Files or Terminal capability until you implement those
contracts. A compatible app requests `services.<your-service-id>` to call it.

For an update, change `version` in `adapter.json`, build a new package directory,
and install it. Existing connections retain their original generation until
explicit replacement or reconnect. No desktop rebuild is required.

stdout is reserved for the protocol. Observe cancellation without undoing
completed mutations, and release resources on failure and disconnect. Native
adapters run with the user's OS permissions; app grants do not sandbox them.
