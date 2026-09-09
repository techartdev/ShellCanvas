# Bundled app service declarations

The generic `AppWindow` wraps the workspace's `SessionServices` before rendering an app. `scopeAppServices` captures the manifest's `requires` and `optional` declarations. Each method checks its capability before forwarding to the fixed workspace handle. Local apps receive no remote service access. The manifest and its capability arrays are copied/frozen by `defineApps`; unsupported and duplicate declarations fail at registration.

| Methods                                 | Declaration                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| list, preview, readText                 | files.read                                                                    |
| saveText                                | files.edit                                                                    |
| createText                              | files.create                                                                  |
| makeDirectory, renameEntry, removeEntry | files.manage                                                                  |
| moveEntry                               | files.move                                                                    |
| terminal                                | terminal                                                                      |
| readHostSettings, applyHostSetting      | host.settings                                                                 |
| chooseUploads                           | files.upload                                                                  |
| chooseDownload                          | files.download                                                                |
| runTransfer, cancelTransfer             | A ticket acquired by this app scope; its original direction determines access |

Required capabilities govern launch availability. Optional capabilities allow enhancements without disabling the entire app when they are absent. Files requires read and optionally uses creation, management, move and transfer services. Editor requires read and optionally uses edit/create. Terminal declares only terminal. Host details uses the connection snapshot with optional host settings. Host capability metadata is still visible as metadata; it is not permission to call an undeclared service.

Scopes are stable per manifest and workspace handle. Multiple instances of one app share a scope; another app cannot run/cancel their transfer tickets. Picker results are copied before exposure, and the scope retains the original ticket metadata. Workspace ownership, capability checks, cancellation and stale-result rejection remain in `bindSession` and the native broker. Reconnect supplies a new base handle and hence a new scope. This does not add per-window grants or user-configurable permission revocation.

The shared file clipboard aliases only move-capable scopes to the owning workspace clipboard. It remains tied to that workspace's lifetime, so scoping does not break cross-window Cut/Paste or let a reader call move through the clipboard. No paths are translated by this layer.

Clipboard imports require `files.upload`, exports require `files.download`, and
Cut synchronization requires `files.move`. `cutToSystem` defaults to publishing a
move reference only. Passing `true` for its `exportContents` argument additionally requires
`files.download`; a move declaration alone cannot authorize external file-content
export. The receiving app adopts every pasted/downloaded/prepared-copy transfer
ticket. Sequence checks require `files.read` and expose no clipboard contents. A
caller cannot start or cancel another app's clipboard transfers; stale preparation
is canceled if its workspace closes.

This is a trusted bundled-module contract. Source modules are not isolated from
the webview, native IPC or source imports. Installed third-party packages use the
separate [runtime app boundary](runtime-apps.md), with their own grants, broker
and source-binding enforcement. They must not import this internal service layer.

## Verification

`src/app-services.test.ts` exercises every guarded method against a capable fake host, missing optional host services, local-app refusal, copied/frozen manifests, ticket ownership and metadata mutation, stale handles, stable scopes and file clipboard aliases. The complete frontend suite passed 60 tests.

With the dev server running, open `/tests/fixtures/app-services.html`. The fixture uses the production `AppWindow`, manifest validator and service wrappers, with a fake provider and three custom app declarations. The browser walkthrough verified:

- Reader: save and terminal refuse before any provider call; read succeeds.
- Editor: declared optional save succeeds. Removing host write support leaves the app open, rejects save and preserves reads.
- Local app: read refuses even while a host is connected.

The provider-call log contained only the expected two reads and one save. The bundled workspace fixture also passed terminal input, editor save, two Files windows sharing/canceling a cut, and Host details loading provider settings. The normal Windows debug build passed. This frontend change does not alter native protocol implementation; hostile-extension/native grant enforcement remains unverified and unimplemented.
