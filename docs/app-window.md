# Runtime app windows

`client.window` controls the calling app's existing desktop window. It accepts
no window, package or workspace identifier and requires no additional grant.
Standalone embeds without desktop controls advertise these methods as unavailable.

```ts
await client.window.setDocumentState({
  dirty: true,
  busy: false,
  title: "Notes",
});
const state = await client.window.getState();
if (state.canMaximize) await client.window.maximize();
await client.window.restore();
await client.window.minimize();
// An app can bring itself back within the current workspace.
await client.window.focus();
```

`getState()` returns `visible`, `focused`, `mode` (`normal`, `maximized`,
`tiled-left` or `tiled-right`) and `canMaximize`. This is a snapshot, not a lock.
Layout updates commit through the desktop renderer; a method reply accepts the
request and does not promise a painted frame. Existing environment events report
visibility changes. Use service discovery when supporting older desktop versions.

`maximize()` is idempotent and unavailable in compact layouts. `restore()` clears
maximization/tiling and restores a minimized window; `focus()` raises and restores
visibility without changing its layout. Neither switches workspaces. Control
requests from an inactive workspace fail with `unavailable`; snapshots remain
readable. Focus restores the app's remembered input control when possible.

`requestClose()` follows the titlebar's close path: busy work prevents the request
with `busy`, and unsaved changes open the desktop's discard review. Native transfers
and settings writes contribute mandatory busy state even if the app reports idle.
Repeated requests are coalesced. The host rechecks document state and workspace
activity before handling the scheduled close. Canceling a request does not undo
an already accepted window action.

Save and release resources **before** requesting close. A successful reply means
the request was accepted, not that the user discarded their draft or the window
closed. Closing destroys the app and its communication channel, so execution after
`await client.window.requestClose()` is not guaranteed. Do not use that continuation
for saving, cleanup or recording a successful close. If the user keeps working,
the same app instance and draft remain available.

Window actions do not grant access to other apps, arbitrary screen geometry,
native OS windows, or connection management. Installed apps still need separate
service permissions for remote operations.

## Verification

The window broker tests check foreign-target rejection, cancellation and missing
host controls. The installed-app Windows fixture exercises SDK discovery,
minimize/focus, maximize/restore, mandatory transfer busy guards, dirty-close
review and clean-close retirement through the real desktop. Run the standalone
SDK verifier first, then the desktop probe described in `runtime-apps.md`.
