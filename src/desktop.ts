// SPDX-License-Identifier: MPL-2.0
import type { DesktopApp } from "./sdk";

export interface DesktopState {
  /** Back-to-front order. Minimized apps remain mounted and keep their state. */
  open: string[];
  minimized: string[];
}
export type DesktopAction =
  | { type: "open" | "focus" | "minimize" | "close"; id: string }
  | { type: "host-connected" };

export function initialDesktop(apps: readonly DesktopApp[]): DesktopState {
  return {
    open: apps.filter((app) => app.window?.openOnStart).map((app) => app.id),
    minimized: [],
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
  if (!apps.some((app) => app.id === action.id)) return state;
  const opened = state.open.includes(action.id);
  if (action.type !== "open" && !opened) return state;
  switch (action.type) {
    case "open":
    case "focus":
      return {
        open: [...state.open.filter((id) => id !== action.id), action.id],
        minimized: state.minimized.filter((id) => id !== action.id),
      };
    case "minimize":
      return state.minimized.includes(action.id)
        ? state
        : { ...state, minimized: [...state.minimized, action.id] };
    case "close":
      return {
        open: state.open.filter((id) => id !== action.id),
        minimized: state.minimized.filter((id) => id !== action.id),
      };
  }
}
