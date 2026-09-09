# Connection and service composition

Status: accepted architectural direction, 2026-09-08. SSH is the first connector and default user path. Serial, Telnet, FTP and device APIs are future adapters, not current support claims. Names and public SDK contracts remain provisional.

Implementation checkpoint (2026-09-09): native workspaces now bind service families to independent runtime adapter sources or built-in SSH. The connection chooser supports saved mixed profiles and transactional source replacement. Apps use accepted source identities; replacing Files retires its old handles while another source's console survives. Native status exposes availability and source identity. See [runtime adapters](adapter-packages.md), [workspace bindings](workspace-bindings.md) and [saved profiles](workspace-profiles.md) for current behavior and evidence. The design below includes future responsibilities beyond this checkpoint.

## A workspace can have several connections

The desktop represents a logical device/workspace. It does not own one mandatory SSH connection. A workspace composes independently selected services from one or more connection adapters:

```text
Desktop apps / optional assistant
          |
Workspace service broker (identity, grants, routing, lifecycle)
          |
          +-- terminal --------> serial adapter
          +-- files -----------> FTP adapter
          +-- device status ---> vendor API adapter
          +-- command probes --> optional independent execution service
```

The default SSH recipe can supply terminal and independent exec via SSH and files via its SFTP subsystem. A second recipe could combine Telnet console and FTP files. Neither recipe changes the Files or Terminal app. A device with only an API need not pretend to have a terminal or a shell.

Prefer composition and small service interfaces over a base class with dozens of unsupported methods. Adapters implement the services they support. Device providers interpret device-specific behavior using those services. Apps depend on services, not adapter IDs or OS names.

## Three extension points

| Extension          | Responsibility                                                                                       | Must not assume                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Connection adapter | Open/authenticate access and supply service handles; describe its configuration and trust properties | A hostname, port, SSH key, byte stream or remote shell exists for every connection    |
| Device provider    | Identify a supported system, expose typed operations and interpret responses                         | Linux utilities, SFTP, independent exec, or all services coming from the same adapter |
| Desktop app        | Present a workflow using declared service requirements and optional enhancements                     | Which protocol, OS or authentication mechanism supplies a service                     |

An API adapter may expose structured requests instead of a stream. A serial console is not independent exec: do not inject `uname` into the user's interactive session to detect a device. A provider that knows a device's console may later offer explicit serialized operations, with ownership, prompts and cancellation designed for that device.

## Proposed core contracts

These are interface responsibilities, not a published SDK:

- **ConnectionAdapter:** versioned ID, configuration schema, credential references, connect/cancel, status events and service discovery. Each connector owns its authentication and resources.
- **ServiceHandle:** a typed operation surface tied to a connection ID and generation. Distinct interfaces for file browsing/read/write/transfers, terminal I/O, independent command execution and device-specific structured operations. Optional features such as terminal resize are explicit.
- **WorkspaceBindings:** routes each service role to a chosen connection and, when necessary, a selected provider. One SSH connection may supply multiple roles; multiple connections may supply one workspace. If two services could satisfy a role, select explicitly rather than silently choosing one.
- **WorkspaceSession:** logical workspace ID, generation, current bindings, capability status and resource leases. Host changes invalidate the workspace generation; reconnecting one adapter invalidates only its handles and dependent requests.
- **DeviceProvider:** consumes the available services, supplies identity and extra operations, and can leave unknown fields unknown. Provider detection failure must preserve independently usable services.
- **AppContext:** scoped service handles and capability events. It does not receive raw connector configuration, passwords, unrestricted IPC or another workspace's handles.

Keep initial implementations concrete and small. Prove the seam with fake console-only, files-only and mixed-adapter fixtures before implementing additional protocols. Do not add speculative methods for every conceivable device.

## Capability and failure behavior

Capabilities belong to live service bindings, not OS labels. An app declares required capabilities; optional capabilities hide or disable only the affected action. Missing file-write support must not disable file browsing. Missing filesystem support must not disable the terminal or device information.

Distinguish **available**, **unsupported**, **checking**, **disconnected** and **denied**, with a user-facing reason and source binding. Current code still uses a simpler capability array; the richer status contract is a next core task. It must not present an unprobed function as confirmed support.

After one adapter fails, recompute only affected capabilities and notify dependent apps. For example, FTP failure leaves the serial console running. Sharing one SSH transport means terminal and SFTP can share a failure dependency; the broker must know that dependency rather than infer it from service names.

On disconnect/close, release owned resources once; shared connections remain until their last lease is released or the user explicitly disconnects them. Cancel in-flight requests, reject stale completions, and retain actionable partial errors. Retry must not replay writes blindly. Never fall back to another protocol, endpoint or credential automatically.

## Identity, paths and permissions

The user explicitly groups connections into a workspace. A matching hostname is insufficient evidence that an FTP endpoint and serial console refer to the same device. Show the service source where it affects a decision, particularly file changes and AI actions. Do not assume an FTP path corresponds to a shell path; cross-service operations need an explicit provider mapping.

Store connector settings separately from credential references. SSH host-key trust, API server identity, Telnet access and local serial access have different properties. Preserve those differences; do not reuse the SSH "Known host verified" badge for other protocols. Insecure or local connection methods must be explicit choices, never automatic SSH fallbacks. No credential sharing between adapters by default.

Permissions bind app, workspace, service source, operation and generation. A reconnect or binding change invalidates pending approvals for the changed service. AI uses this same broker, rather than receiving independent arbitrary network or shell access.

## UI direction

The common flow stays simple: choose SSH, connect, see the desktop. An advanced connection editor can add a console, file service or API and show what each supplies. This composition model must not turn initial connection into a complex configuration screen.

The shared desktop design stays coherent across adapters. Unavailable apps/actions remain discoverable with a readable reason, while supported functions remain usable. Branding and shared chrome should become connection-neutral when non-SSH connectors actually ship; do not rename the product or imply they exist today.

## Incremental migration

1. **Implemented first seam:** `CommandProbe` and `ProbeContext` separate system detection from the concrete SSH connection. Missing command access is valid. Ordered providers run within a total detection budget, and fallback preserves supplied capabilities. This proves limited-device detection with fixtures; it is not a connection-plugin runtime.
2. **Implemented service/lifecycle seams:** generic file, console, settings and connection identity/lifecycle types now live behind a dependency boundary with no russh/Tauri imports. Native health/disconnect uses the neutral established-connection resource with bounded once-only teardown; see [lifecycle verification](connection-lifecycle.md). Adapter setup schemas and general command/API contracts remain. Existing SSH IPC stays the compatibility facade during migration.
3. Add explicit workspace service bindings and per-binding status, generations and teardown. Prove a mixed workspace with fake adapters, including loss of one leg and shared connection cleanup.
4. Bind apps and AI to the service broker; replace Unix-specific path assumptions and SSH-specific connection metadata in shared UI.
5. Implement a second real adapter to validate the contract, selected from an actual device/workflow. Serial, Telnet, FTP and API connectors remain separate backlog items. Preserve SSH/SFTP regression checks throughout.

The current `shellcanvas-core` package remains at `crates/ssh-core`. Its transport dependencies have not yet been separated into a dedicated adapter crate; do that at the service boundary rather than merely renaming files.
