// SPDX-License-Identifier: MPL-2.0
import {
  initialDesktop,
  updateDesktop,
  type DesktopAction,
  type DesktopState,
} from "./desktop";
import type { ConnectOptions, DesktopApp, HostProfile, Session } from "./sdk";
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
  };
}
export function sameEndpoint(a: HostProfile, b: HostProfile) {
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
  connection?: HostProfile;
}
export interface Workspaces {
  items: Workspace[];
  active: string;
}
export type WorkspaceAction =
  | {
      type: "connected";
      session: Session;
      label: string;
      connection?: HostProfile;
    }
  | {
      type: "reconnected";
      key: string;
      previousSessionId: number;
      session: Session;
      connection: HostProfile;
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
  connection?: HostProfile,
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
    case "status": {
      const target = state.items.find(
        (w) => w.session?.id === action.sessionId,
      );
      // A late poll must never revive a closed or replaced workspace.
      if (!target?.session || target.connected === false) return state;
      if (
        target.connected === action.status.connected &&
        JSON.stringify(target.session.services) ===
          JSON.stringify(action.status.services)
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
