# App connections and HTTP

`client.network` is an optional desktop service, protected by the
`system.network` grant. Use `services.list()` to distinguish permission from
availability. It is not an unrestricted browser/network permission; installed
frames retain `connect-src 'none'` and cannot read native credentials.

```ts
const connection = await desktop.network.configure({
  slot: "model",
  suggestedEndpoint: "https://api.example.com/v1/chat/completions",
});
if (!connection) return; // User canceled the trusted desktop form.
const response = await desktop.network.postJSON(
  {
    slot: "model",
    revision: connection.revision,
    body: {
      model: "my-model",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    },
  },
  signal,
);
try {
  const decoder = new TextDecoder();
  for (;;) {
    const bytes = await response.read(signal);
    if (bytes === null) break;
    consume(decoder.decode(bytes, { stream: true }));
  }
  consume(decoder.decode());
} finally {
  await response.close();
}
```

## Small public contract

- `profile(slot)` returns endpoint, opaque revision, `hasKey` and `remembered`,
  or null. It never returns the key.
- `configure({slot, suggestedEndpoint})` opens a trusted desktop form. The user
  chooses the complete endpoint and optional bearer key. The result contains
  only public connection metadata. Keep the key out of app fields and history.
- `forget(slot)` removes this app's configured connection and saved credential.
- `postJSON({slot, revision, body}, signal)` posts a JSON body to the configured
  exact endpoint and returns status/content type plus a byte reader and close.
  The application owns protocol parsing, error handling and retry decisions.

Slots contain 1–64 ASCII letters, digits, underscores or hyphens. Profiles belong
to an unpredictable installation principal, shared by its windows and updates,
not a host session. A removal retires that principal, so a later package reusing
the same app ID cannot inherit its saved connection. The desktop supplies the
principal; a caller cannot name another app. Changing an
endpoint requires a newly entered key rather than reusing the former endpoint's
key. The native host adds the bearer header. HTTP redirects are not followed.

Credentials are optionally stored using the platform credential store (Windows
Credential Manager, macOS Keychain, or Linux Secret Service through `keyring`).
Session-only mode removes a previously remembered credential and keeps the new
connection in process memory. Locked/unavailable stores report an error; they
never silently save plaintext. Installed app loading on macOS/Linux remains
subject to the existing isolation gates; cross-platform source is not runtime
verification on those systems.

HTTP is allowed for explicitly configured local/network model servers, with a
visible unencrypted-connection notice. HTTPS uses platform certificate validation.
URLs with embedded credentials, query strings or fragments are rejected. There
are no arbitrary methods, headers, cookies, WebSockets, redirects or downloaded
code execution in this initial service. Extend only for a demonstrated app need.

## Ownership and limits

An opened response belongs to the calling app window. Reads are sequential;
breaking out early requires `close()`. EOF, cancellation, errors and frame teardown
release the native request. A connection revision mismatch fails before sending.
An in-flight request keeps its captured endpoint; changing settings cannot
retarget it. Cancellation stops transport, but cannot undo a request processed
by the server. No automatic retry is provided.

Bodies are at most 3 MiB of UTF-8 JSON; responses are at most 16 MiB, delivered
in app chunks of at most 32 KiB. Each window has at most four active requests;
the native process has at most 32. Connect timeout is 15 seconds; HTTP lifetime
is 180 seconds, with an additional five-minute resource cleanup deadline. These
are network/context budgets, unrelated to the filesystem tree/transfer model.

The native HTTP fixture uses a local test endpoint and a generated fixture key;
it does not read or modify real saved credentials. Broker tests cover denied
grants, owner identity, partial chunks and cancellation during native prepare.
