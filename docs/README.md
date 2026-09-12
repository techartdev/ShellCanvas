# Documentation map

The public user documentation lives at [shellcanvas.com/docs](https://shellcanvas.com/docs/). The files in this directory are engineering references, contracts, verification records and implementation history for contributors.

## Start here

- [Architecture](architecture.md) and [connection composition](connections.md)
- [Local verification and release checklist](verification.md)
- [Contributing](../CONTRIBUTING.md), [security policy](../SECURITY.md), [roadmap](../ROADMAP.md) and [changelog](../CHANGELOG.md)

## User-facing implementation references

- Device setup: [Home Assistant via Terminal & SSH](home-assistant.md)
- Connections and trust: [host profiles](host-profiles.md), [SSH host identity](ssh-host-trust.md), [recovery](connection-recovery.md) and [workspace profiles](workspace-profiles.md)
- Desktop work: [Files](file-actions.md), [transfers](transfers.md), [Editor](text-editor.md), [Terminal](terminal-services.md), [settings](settings.md) and [themes](themes.md)
- Extensions: [runtime apps](runtime-apps.md), [repository installation](repository-apps.md), [app SDK](app-sdk.md), [adapter SDK](adapter-sdk.md) and [custom services](custom-services.md)

## Contracts and API design

- [System API](system-api.md), [app services](app-services.md), [service availability](service-availability.md), [client platform compatibility](client-platform-compatibility.md) and [window management](window-management.md)
- [Filesystem contract](filesystem-contract.md), [workspace bindings](workspace-bindings.md), [adapter process protocol](adapter-process.md) and [providers](providers.md)
- Runtime APIs: [files](app-files.md), [transfers](app-transfers.md), [console](app-console.md), [storage](app-storage.md), [events](app-events.md), [clipboard](app-clipboard.md), [network](app-network.md), [windows](app-window.md) and [host settings](app-host-settings.md)

## Verification records and history

Files with `validation`, `completion`, `progress`, `history`, `acceptance`, `goal`, `roadmap`, `backlog`, `workflows` or platform names in their titles are retained engineering evidence. They identify exactly what was tested at a checkpoint; they are not promises that every platform, host or future feature is supported. New evidence should state its date, environment, scope and limitations without including credentials, private host identifiers or user data.
