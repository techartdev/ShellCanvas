# Remote settings for runtime apps

`client.hostSettings` exposes the device provider's settings contract to installed apps. It is separate from `client.settings`, which stores the app's local preferences. Setting IDs, labels, descriptions, text/select editors, choices, read-only reasons and revisions come from the selected provider. Apps do not need Linux commands or vendor-specific assumptions to render a settings form.

## Read and propose a change

Declare `host.settings.read` to read fields and `host.settings.write` to apply changes. The install/update review lists these separately. The device capability remains `host.settings`; capability support never grants write permission. The older capability name alone is not a grant for these runtime methods.

`hostSettings.read({binding}, signal?)` returns `RemoteHostSetting[]`. Obtain the opaque binding from `environment.get()` after the app has accepted its connection. Each field carries that binding, an opaque provider ID and a nullable revision. Preserve all three when submitting a change. Null values/revisions and read-only reasons describe partial device support; do not enable Apply without a writable field and a revision.

```ts
const environment = await client.environment.get();
if (environment.binding) {
  const fields = await client.hostSettings.read({
    binding: environment.binding,
  });
  renderProviderFields(fields);
}

async function applyProposal(field: RemoteHostSetting, proposed: string) {
  if (!field.writable || !field.revision) return;
  const answer = await client.system.dialogs.messageBox({
    title: `Change ${field.label}?`,
    message: `Current: ${field.value ?? "Unavailable"}\nProposed: ${proposed}`,
    buttons: [
      { id: "apply", label: "Apply to host" },
      { id: "cancel", label: "Keep editing" },
    ],
    defaultId: "cancel",
    cancelId: "cancel",
  });
  if (answer !== "apply") return;
  const confirmed = await client.hostSettings.apply(field, proposed);
  renderConfirmedField(confirmed);
}
```

The example uses `system.dialogs` as an additional app permission. `apply(setting, value, signal?)` itself is a service call and does not open a confirmation dialog. Apps own proposal/review UI; providers own value validation, account authorization, revision checks and readback. Only one field is applied per call. Extra app-supplied native/session parameters are rejected.

## Lifecycle and conflicts

Read and apply discovery entries are `system.hostSettings.read` and `system.hostSettings.apply`. Check both `granted` and `available`. A read-only app can inspect fields whose provider supports writes without acquiring write permission. Individual `writable` fields describe provider support, not the app's grants.

The host captures the app's accepted service object and binding before dispatch. A retained setting cannot target a replacement connection. A late read is refused after cancellation, capability loss or replacement. A write finishing after those changes reports uncertainty instead of attaching its result to the new host. Refresh settings after accepting a replacement; do not silently transfer old proposals or revisions to it.

Abort signals stop waiting through the app channel. The current native settings contract cannot undo or interrupt an already-dispatched operation. The desktop automatically keeps the window busy until an apply settles, even if the app cancels or reports `busy: false`. This state combines with transfer activity and app-reported busy state. Closing the channel retires new calls; native work already dispatched must still settle. No automatic write retries occur.

Each window allows one outstanding read and one outstanding apply. An aborted request continues occupying its slot until native completion, preventing repeated cancellation from creating unlimited background work. A new call receives `busy` while the corresponding slot is occupied. Reads do not hold the window's write-close guard.

On a conflict, failed readback, timeout or connection change, retain the proposal and refresh before offering another apply. Provider revisions are preconditions, not a distributed lock or rollback guarantee. The current Linux provider's behavior and remaining live-system validation are documented in [remote-settings.md](remote-settings.md). There is no automatic cross-window value notification; reread for fresh values.

## Verification

Seven SDK/RPC tests cover independent grants, opaque IDs/revisions, Unicode field metadata, read-only fields, rejected extra parameters, provider failures, canceled native operations, source replacement and close guards. The original 56-check Windows desktop checkpoint exercised the public client from an independently built SDK package, injected host settings, stale revisions, cancellation while native work continues, combined transfer/settings guards, reconnect and revoked write permission. Those checks remain in the expanded desktop fixture. They do not change a real host's settings. Installed process-adapter settings are implemented and covered by the native adapter fixture's settings round trip/conflict checks and the independent SDK settings starter tests.
