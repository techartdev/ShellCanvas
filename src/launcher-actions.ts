// SPDX-License-Identifier: MPL-2.0
import type { MenuAction } from "./components/ContextMenu";
import type { DesktopAction } from "./desktop";
import type { DesktopApp } from "./sdk";

export interface LauncherWindowAction {
  id: string;
  label: string;
}

/** Shared launcher/dock menu behavior, kept independent of DOM event wiring. */
export function launcherMenuActions({
  app,
  unavailable,
  canPin,
  windows,
  closeLauncher,
  dispatch,
  pin,
}: {
  app: DesktopApp;
  unavailable: boolean;
  canPin: boolean;
  windows: readonly LauncherWindowAction[];
  closeLauncher(): void;
  dispatch(action: DesktopAction): void;
  pin(): void;
}): MenuAction[] {
  return [
    {
      id: "open",
      label: app.window?.multiple
        ? `New ${app.title} window`
        : `Open ${app.title}`,
      disabled: unavailable,
      run: () => {
        closeLauncher();
        dispatch({ type: "new", id: app.id });
      },
    },
    {
      id: "pin",
      label: "Add to desktop",
      separatorBefore: true,
      disabled: !canPin,
      run: pin,
    },
    ...windows.map(({ id, label }) => ({
      id,
      label,
      run: () => {
        closeLauncher();
        dispatch({ type: "focus", id });
      },
    })),
  ];
}
