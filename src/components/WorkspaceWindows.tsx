// SPDX-License-Identifier: MPL-2.0
import { useLayoutEffect, useState } from "react";
import { apps } from "../apps/registry";
import { focusedApp, type DesktopAction } from "../desktop";
import { bindSession } from "../session-services";
import type { HostServices } from "../sdk";
import type { Workspace } from "../workspaces";
import { AppWindow } from "./AppWindow";

export function WorkspaceWindows({
  workspace,
  backend,
  active,
  preview,
  dispatch,
  connect,
  reportError,
}: {
  workspace: Workspace;
  backend: HostServices;
  active: boolean;
  preview: boolean;
  dispatch(action: DesktopAction): void;
  connect(): void;
  reportError(message: string): void;
}) {
  // Each keyed workspace owns a fixed handle. Switching never replaces its session.
  const [binding] = useState(() => bindSession(backend, workspace.session));
  useLayoutEffect(() => {
    binding.activate();
    return binding.dispose;
  }, [binding]);
  const context = {
    session: workspace.session,
    services: binding.services,
    preview,
    active,
    connect,
    reportError,
  };
  return (
    <div
      className="workspace-windows"
      hidden={!active}
      inert={!active}
      aria-label={`${workspace.label} workspace`}
    >
      {apps
        .filter((app) => workspace.desktop.open.includes(app.id))
        .map((app) => (
          <AppWindow
            key={app.id}
            app={app}
            context={context}
            focused={active && focusedApp(workspace.desktop) === app.id}
            focus={() => dispatch({ type: "focus", id: app.id })}
            visible={active && !workspace.desktop.minimized.includes(app.id)}
            order={workspace.desktop.open.indexOf(app.id)}
            minimize={() => dispatch({ type: "minimize", id: app.id })}
            close={() => dispatch({ type: "close", id: app.id })}
          />
        ))}
    </div>
  );
}
