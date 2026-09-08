// SPDX-License-Identifier: MPL-2.0
import {
  initialDesktop,
  updateDesktop,
  type DesktopAction,
  type DesktopState,
} from "./desktop";
import type { DesktopApp, Session } from "./sdk";
export interface Workspace {
  key: string;
  label: string;
  session: Session | null;
  desktop: DesktopState;
}
export interface Workspaces {
  items: Workspace[];
  active: string;
}
export type WorkspaceAction =
  | { type: "connected"; session: Session; label: string }
  | { type: "select"; key: string }
  | { type: "remove"; sessionId: number }
  | { type: "desktop"; key: string; action: DesktopAction };
export function initialWorkspaces(
  apps: readonly DesktopApp[],
  session: Session | null,
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
        { type: "connected", session, label: session.info.hostname },
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
    case "connected": {
      const key = `session-${action.session.id}`;
      if (state.items.some((w) => w.key === key)) return state;
      return {
        items: [
          ...state.items,
          {
            key,
            session: action.session,
            label: action.label,
            desktop: initialDesktop(apps),
          },
        ],
        active: key,
      };
    }
    case "select":
      return state.items.some((w) => w.key === action.key)
        ? { ...state, active: action.key }
        : state;
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
