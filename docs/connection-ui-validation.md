# Connection UI validation

The Windows fixture renders the normal desktop, connection form, host-key review
panel, Files and Terminal with injected connection services. It passes 12 checks
at 1360×900:

- Load a saved workspace with separate file and SSH console sources.
- Display the exact host, algorithm and fingerprint, requiring an explicit
  verification checkbox before trust can be accepted.
- Decline trust without connecting; cancel pending initialization and enable a retry.
- Reject a stale review callback without replacing the newer trust prompt.
- Disconnect a late session from the canceled attempt instead of adopting it.
- Complete the reviewed connection and expose both Files and Terminal.
- Apply a file-source replacement and display its post-commit cleanup warning.
- Preserve the existing console element and shell across that replacement.
- Poll partial file-source failure, show its unavailable reason and keep the
  workspace and console open.

```powershell
npm run tauri -- build --debug --no-bundle --config src-tauri/tauri.connection-ui-probe.conf.json
node scripts/run-extension-probe.mjs
```

The runner writes `.local/native-extension-probe/result.json`; the retained
checkpoint is `.local/native-extension-probe/connection-ui-result.json`.
Restore the normal executable afterward with
`npm run tauri -- build --debug --no-bundle`.

These checks exercise the production UI and callback/lifecycle boundary with
synthetic services. They open no network connections, approve no real host keys,
write no trust store and do not touch the OS clipboard. Real SSH handshake and
source composition are covered separately by native loopback tests; installed
adapter processes, profiles and custom services have their own native fixture.
This is layered evidence, not a claim that this fixture connects to a real VPS.

Draft/undo preservation and Save As against a replacement source are covered by
the [source-switch fixture](workspace-bindings.md#desktop-source-switch-probe).
The [service availability walkthrough](service-availability.md#verification)
also covers continued file browsing when the console leg is unavailable.
