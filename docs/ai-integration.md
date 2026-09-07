# Optional AI assistant and WispCrew reuse

Status: source assessment, not an implementation. Inspected the user-owned WispCrew checkout on 2026-09-08 (HEAD `1d8c19045206ac871fa35b6854a3909105d60011`; working files may differ). No WispCrew files, credentials or running services were modified or used. The assistant remains optional; no remote WispCrew installation is required by the base product.

## Reusable boundaries found

| Source in WispCrew                 | Useful logic                                                                           | Integration constraint                                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/agent.ts`       | Provider-driven tool loop, streaming events, abort, step limits and approval callbacks | Imports ToolRegistry and uses `process.cwd`; not a browser-portable package as delivered                                                                    |
| `packages/tools/src/registry.ts`   | Tool schema dispatch and deadlines                                                     | Default tools include the local shell and local file writes. Never instantiate these defaults for an SSH workspace                                          |
| `packages/llm/src/`                | Model adapters and retry/error handling                                                | The package entry point also exports Node-specific auth/filesystem modules; inspect a narrow extraction rather than importing it wholesale into the webview |
| `packages/runtime/src/host.ts`     | Host-supplied storage and secret protection                                            | Electron-free is not Node-free: runtime uses Node APIs and Buffer                                                                                           |
| `packages/runtime/src/protocol.ts` | Request/response/event frames and approval ask/decision flow over streams              | Local sockets/pipes or paired TLS need a native bridge and explicit authentication; browser fetch is not a direct substitute                                |
| `packages/shared/src/`             | Shared data and event types                                                            | Good candidate for a small versioned contract after checking actual dependencies                                                                            |

The checkout declares MIT licensing. If source is reused later, preserve its copyright/license notices and review the specific dependencies being included. No source has been copied into this project during this assessment.

## Recommended boundary

```text
Assistant desktop app
  -> replaceable AssistantService (stream / cancel / approval / result)
     -> selected model runtime
     -> host tool broker -> session-bound device services -> SSH
```

Keep model credentials in native secret storage or the explicitly selected companion service, never an app manifest or shared frontend context. The assistant can use a local or user-configured model service. Sending selected host content to that service must be visible and user-controlled; do not upload terminal history or files automatically.

The host tool broker must support [composite service bindings](connections.md): files may come from FTP while console access comes from serial and device operations from an API. Tool availability follows individual bindings. Do not assume shell paths map to file-service paths, auto-select another adapter, or treat a console as independent exec. Approvals identify the workspace, service source and generation.

## Integration spike: decide before choosing a runtime

**Option A: optional WispCrew companion connection.** Reuse the existing engine through a native adapter. This adds no Node dependency to the basic desktop package, but requires WispCrew when the user enables that mode. Its ordinary tools act on the machine running the agent; an ShellCanvas host broker must supply the intended remote operations. Verify protocol compatibility and how host tools are registered rather than assuming existing daemon methods support this already.

**Option B: extract a portable agent kernel.** Share model/event/tool-loop abstractions and inject storage, HTTP, secrets and execution through native services. This better fits a self-contained Tauri/mobile product but requires work in WispCrew's package boundaries and parity tests. Do not silently fork a large copy of its runtime.

A bundled Node sidecar is not the default: it changes package size and mobile feasibility. Measure it only if the other options cannot meet the requirements. The spike should report actual startup/package costs and a fake-model streamed turn, cancel and approval round trip before a choice is made.

## First assistant scope

1. Host-scoped conversation, streaming text, cancellation and explicit model setup; useful without executing tools.
2. Optional context from host information and user-selected files. Tool definitions come from available provider services.
3. Read operations through the existing host session, with bounded results and no credential access.
4. Command/write actions only through a native broker, with a concrete operation preview, target host/session, approval and completion result. An approval belongs to one operation and becomes invalid after reconnect, host switch or cancellation.

No unrestricted exec API is introduced just to connect an LLM. Provider/device errors are data to explain, not permission to try arbitrary fallback commands. Host content and tool output are untrusted inputs; they cannot grant permissions or redirect the assistant to another host. Enforce step, elapsed-time and output budgets. Cancellation must stop pending work and report the outcome honestly; it cannot promise to undo an already executed remote action.

See AI-01 through AI-03 in the backlog. Multi-agent rooms, scheduling, unattended work and cross-host actions can reuse later WispCrew capabilities after the single-host assistant is dependable.
