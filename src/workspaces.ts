// SPDX-License-Identifier: MPL-2.0
import {
  initialDesktop,
  updateDesktop,
  type DesktopAction,
  type DesktopState,
} from "./desktop";
import type { ConnectOptions, DesktopApp, HostProfile, Session } from "./sdk";
import type { AdapterProfile, SourceReplacement } from "./adapters";
import type { ConnectionIdentity } from "./sdk";
export type WorkspaceConnection = HostProfile | AdapterProfile;
export function isAdapterProfile(
  connection: WorkspaceConnection,
): connection is AdapterProfile {
  return "kind" in connection && connection.kind === "adapters";
}
import type { WorkspaceStatus } from "./sdk";
import { capabilityLabels, capabilityStatus, type Capability } from "./sdk";
export function connectionProfile(
  options: ConnectOptions,
  name: string,
): HostProfile {
  return {
    name,
    host: options.host,
    port: options.port,
    username: options.username,
    keyPath: options.keyPath,
    ...(options.allowLegacyMac ? { allowLegacyMac: true } : {}),
  };
}
export function sameEndpoint(a: WorkspaceConnection, b: WorkspaceConnection) {
  if (isAdapterProfile(a) || isAdapterProfile(b)) {
    if (!isAdapterProfile(a) || !isAdapterProfile(b)) return false;
    const identity = (profile: AdapterProfile) =>
      JSON.stringify({
        sources: profile.sources
          .map((source) => ({
            key: source.key,
            id: source.id,
            configuration: Object.entries(source.configuration).sort(
              ([a], [b]) => a.localeCompare(b),
            ),
          }))
          .sort((a, b) => a.key.localeCompare(b.key)),
        bindings: Object.entries(profile.bindings).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      });
    return identity(a) === identity(b);
  }
  return (
    a.host.trim().toLowerCase() === b.host.trim().toLowerCase() &&
    a.port === b.port &&
    a.username === b.username
  );
}
export interface Workspace {
  key: string;
  label: string;
  session: Session | null;
  desktop: DesktopState;
  connected?: boolean;
  connection?: WorkspaceConnection;
}
export interface Workspaces {
  items: Workspace[];
  active: string;
}
export type WorkspaceAction =
  | {
      type: "source-replaced";
      sessionId: number;
      sourceKey: string;
      expected: ConnectionIdentity;
      result: SourceReplacement;
      profile: AdapterProfile;
    }
  | {
      type: "connected";
      session: Session;
      label: string;
      connection?: WorkspaceConnection;
    }
  | {
      type: "reconnected";
      key: string;
      previousSessionId: number;
      session: Session;
      connection: WorkspaceConnection;
      label: string;
    }
  | { type: "select"; key: string }
  | { type: "remove"; sessionId: number }
  | { type: "lost"; sessionId: number }
  | { type: "status"; sessionId: number; status: WorkspaceStatus }
  | { type: "desktop"; key: string; action: DesktopAction };
export function initialWorkspaces(
  apps: readonly DesktopApp[],
  session: Session | null,
  connection?: WorkspaceConnection,
): Workspaces {
  const local: Workspace = {
    key: "local",
    label: "Local desktop",
    session: null,
    desktop: initialDesktop(apps),
  };
  const state = { items: [local], active: local.key };
  return session
    ? updateWorkspaces(
        state,
        {
          type: "connected",
          session,
          label: session.info.hostname,
          connection,
        },
        apps,
      )
    : state;
}
export function updateWorkspaces(
  state: Workspaces,
  action: WorkspaceAction,
  apps: readonly DesktopApp[],
): Workspaces {
  switch (action.type) {
    case "source-replaced": {
      const target = state.items.find(
        (w) => w.session?.id === action.sessionId,
      );
      if (
        !target?.session ||
        !target.connection ||
        !isAdapterProfile(target.connection)
      )
        return state;
      const index = target.connection.sources.findIndex(
        (source) => source.key === action.sourceKey,
      );
      if (
        index < 0 ||
        JSON.stringify(target.session.connections?.[index]) !==
          JSON.stringify(action.expected) ||
        action.result.sourceRevision <= (target.session.sourceRevision ?? 0)
      )
        return state;
      const replacement = action.profile.sources.find(
        (source) => source.key === action.sourceKey,
      );
      if (!replacement) return state;
      const connection: AdapterProfile = {
        ...target.connection,
        sources: target.connection.sources.map((source, i) =>
          i === index ? replacement : source,
        ),
      };
      return {
        ...state,
        items: state.items.map((w) =>
          w !== target
            ? w
            : {
                ...w,
                connection,
                connected: action.result.connected,
                session: {
                  ...target.session!,
                  sourceRevision: action.result.sourceRevision,
                  connections: action.result.connections,
                  services: action.result.services,
                  customSources: action.result.customSources,
                  info: {
                    ...target.session!.info,
                    capabilities: action.result.services
                      .filter((item) => item.state === "available")
                      .map((item) => item.capability),
                  },
                },
              },
        ),
      };
    }
    case "status": {
      const target = state.items.find(
        (w) => w.session?.id === action.sessionId,
      );
      // A late poll must never revive a closed or replaced workspace.
      if (!target?.session || target.connected === false) return state;
      if (
        (target.session.sourceRevision ?? 0) !==
        (action.status.sourceRevision ?? 0)
      )
        return state;
      if (
        target.connected === action.status.connected &&
        JSON.stringify(target.session.services) ===
          JSON.stringify(action.status.services) &&
        JSON.stringify(target.session.customSources) ===
          JSON.stringify(
            action.status.customSources ?? target.session.customSources,
          )
      )
        return state;
      return {
        ...state,
        items: state.items.map((w) =>
          w !== target
            ? w
            : {
                ...w,
                connected: action.status.connected,
                session: {
                  ...target.session!,
                  services: action.status.services,
                  customSources:
                    action.status.customSources ??
                    target.session!.customSources,
                  info: {
                    ...target.session!.info,
                    capabilities: action.status.services
                      .filter((item) => item.state === "available")
                      .map((item) => item.capability),
                  },
                },
              },
        ),
      };
    }
    case "connected": {
      const key = `session-${action.session.id}`;
      if (
        state.items.some(
          (w) => w.key === key || w.session?.id === action.session.id,
        )
      )
        return state;
      return {
        items: [
          ...state.items,
          {
            key,
            session: action.session,
            label: action.label,
            desktop: initialDesktop(apps),
            connected: true,
            connection: action.connection,
          },
        ],
        active: key,
      };
    }
    case "reconnected": {
      const target = state.items.find((w) => w.key === action.key);
      if (
        !target ||
        state.items.some(
          (w) => w.key !== action.key && w.session?.id === action.session.id,
        ) ||
        target.connected !== false ||
        target.session?.id !== action.previousSessionId ||
        !target.connection ||
        !sameEndpoint(target.connection, action.connection)
      )
        return state;
      return {
        ...state,
        active: target.key,
        items: state.items.map((w) =>
          w.key === target.key
            ? {
                ...w,
                session: action.session,
                connection: action.connection,
                label: action.label,
                connected: true,
              }
            : w,
        ),
      };
    }
    case "select":
      return state.items.some((w) => w.key === action.key)
        ? { ...state, active: action.key }
        : state;
    case "lost":
      return {
        ...state,
        items: state.items.map((w) =>
          w.session?.id === action.sessionId
            ? {
                ...w,
                connected: false,
                session: {
                  ...w.session,
                  info: { ...w.session.info, capabilities: [] },
                  services: (Object.keys(capabilityLabels) as Capability[]).map(
                    (capability) => {
                      const status = capabilityStatus(w.session!, capability);
                      return status.state === "unsupported"
                        ? status
                        : {
                            ...status,
                            state: "disconnected" as const,
                            reason: "Reconnect this host to use this service",
                          };
                    },
                  ),
                },
              }
            : w,
        ),
      };
    case "remove": {
      const items = state.items.filter(
        (w) => w.session?.id !== action.sessionId,
      );
      return {
        items,
        active: items.some((w) => w.key === state.active)
          ? state.active
          : items.at(-1)!.key,
      };
    }
    case "desktop":
      return {
        ...state,
        items: state.items.map((w) =>
          w.key === action.key
            ? { ...w, desktop: updateDesktop(w.desktop, action.action, apps) }
            : w,
        ),
      };
  }
}
