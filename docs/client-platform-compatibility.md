# Client platform compatibility

An app runs inside the **ShellCanvas client**. The connected host's OS and services are separate: an Android client connected to a Linux server is still Android.

Runtime app source manifests (`shellcanvas.json`) and built packages accept an optional `clientPlatforms` list:

```json
"clientPlatforms": ["windows", "macos", "linux"]
```

Supported identifiers are `windows`, `macos`, `linux`, `android`, `ios`, and `web`. These are client targets, not a claim that ShellCanvas currently ships on all of them. A browser preview is `web`, even on a Windows computer. Native clients report their Rust compile target through the parent application's IPC; remote labels and browser user-agent guesses are not used.

Omission preserves existing packages and means **no platform restriction declared**, not tested compatibility everywhere. Explicit lists must be nonempty, contain known targets, and contain no duplicates. The package builder preserves the list; it is covered by the reviewed artifact fingerprint.

The app manager shows incompatibility and refuses installation or updates that cannot run on this client. Already installed packages remain listed and removable, but cannot be enabled or launched on an incompatible client. Launch revalidates authoritative catalog storage, so restored catalogs and stale launchers cannot bypass the check. Unsupported updates leave the installed version intact. This is a compatibility rule, not a replacement for permissions or runtime isolation.

Apps inspect the client independently of the remote workspace:

```ts
const environment = await canvas.environment.get();
const platform = environment.client?.platform; // absent on older ShellCanvas
const remoteHost = environment.host;           // remote display metadata
const services = await canvas.services.list(); // availability and permissions
```

Use service availability and operation discovery for optional features; platform matching does not guarantee a driver, filesystem operation, or permission. `environment.client` stays tied to the client when switching remote workspaces. `unknown` is reported if a native target is not recognized and does not satisfy an explicit platform list.

Drive Bridge is currently a separately installed native helper, not a runtime UI package. Its settings and native install/attach entry points independently restrict it to Windows, Linux, and macOS. Driver checks remain separate. The core filesystem provider contract does not acquire a driver dependency.

## Deferred

- Android/iOS builds and native app-frame isolation verification.
- Minimum OS/WebView versions and architecture-specific native artifacts (runtime UI packages are JavaScript/CSS; executable connection adapters already have their own platform contract).
- Optional client-feature requirements in manifests if service discovery proves insufficient. Avoid a second overlapping permission system.
- Package publication/versioning for this additive SDK change follows the release track; existing clients reject manifests with unknown fields, so packages using this field need an updated ShellCanvas client.
