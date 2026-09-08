// SPDX-License-Identifier: MPL-2.0
import type { DesktopApp } from "./sdk";

export interface DesktopState {
  /** Back-to-front order. Minimized apps remain mounted and keep their state. */
  open: string[];
  minimized: string[];
  instances: Record<
    string,
    {
      appId: string;
      ordinal: number;
      launch?: { path?: string };
      dirty?: boolean;
      busy?: boolean;
      title?: string;
    }
  >;
  serials: Record<string, number>;
}
export type DesktopAction =
  | { type: "open" | "focus" | "minimize" | "close"; id: string }
  | { type: "new"; id: string; launch?: { path?: string } }
  | { type: "show-desktop" }
  | {
      type: "document-state";
      id: string;
      dirty: boolean;
      busy: boolean;
      title?: string;
    }
  | { type: "host-connected" };

export function initialDesktop(apps: readonly DesktopApp[]): DesktopState {
  return {
    open: apps.filter((app) => app.window?.openOnStart).map((app) => app.id),
    minimized: [],
    instances: Object.fromEntries(
      apps
        .filter((app) => app.window?.openOnStart)
        .map((app) => [app.id, { appId: app.id, ordinal: 1 }]),
    ),
    serials: Object.fromEntries(
      apps.filter((app) => app.window?.openOnStart).map((app) => [app.id, 1]),
    ),
  };
}

export function focusedApp(state: DesktopState): string | undefined {
  return state.open.filter((id) => !state.minimized.includes(id)).at(-1);
}

export function updateDesktop(
  state: DesktopState,
  action: DesktopAction,
  apps: readonly DesktopApp[],
): DesktopState {
  if (action.type === "host-connected") {
    return apps
      .filter((app) => app.scope === "host" && app.window?.openOnStart)
      .reduce(
        (current, app) =>
          updateDesktop(current, { type: "open", id: app.id }, apps),
        state,
      );
  }
  if (action.type === "show-desktop")
    return {
      ...state,
      minimized:
        state.minimized.length === state.open.length ? [] : [...state.open],
    };
  if (action.type === "open" || action.type === "new") {
    const app = apps.find((app) => app.id === action.id);
    if (!app) return state;
    const existing = state.open
      .filter((id) => state.instances[id].appId === app.id)
      .at(-1);
    if (existing && (action.type === "open" || !app.window?.multiple))
      return updateDesktop(state, { type: "focus", id: existing }, apps);
    const ordinal = (state.serials[app.id] ?? 0) + 1;
    const id = ordinal === 1 ? app.id : `${app.id}:${ordinal}`;
    return {
      ...state,
      open: [...state.open, id],
      serials: { ...state.serials, [app.id]: ordinal },
      instances: {
        ...state.instances,
        [id]: {
          appId: app.id,
          ordinal,
          launch: action.type === "new" ? action.launch : undefined,
        },
      },
    };
  }
  const opened = state.open.includes(action.id);
  if (!opened) return state;
  switch (action.type) {
    case "document-state": {
      const previous = state.instances[action.id];
      if (
        previous.dirty === action.dirty &&
        previous.busy === action.busy &&
        previous.title === action.title
      )
        return state;
      return {
        ...state,
        instances: {
          ...state.instances,
          [action.id]: {
            ...previous,
            dirty: action.dirty,
            busy: action.busy,
            title: action.title,
          },
        },
      };
    }
    case "focus":
      return {
        ...state,
        open: [...state.open.filter((id) => id !== action.id), action.id],
        minimized: state.minimized.filter((id) => id !== action.id),
      };
    case "minimize":
      return state.minimized.includes(action.id)
        ? state
        : { ...state, minimized: [...state.minimized, action.id] };
    case "close":
      const instances = { ...state.instances };
      delete instances[action.id];
      return {
        ...state,
        instances,
        open: state.open.filter((id) => id !== action.id),
        minimized: state.minimized.filter((id) => id !== action.id),
      };
  }
}
