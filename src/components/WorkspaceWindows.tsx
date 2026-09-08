// SPDX-License-Identifier: MPL-2.0
import { useLayoutEffect, useState } from "react";
import { apps } from "../apps/registry";
import { focusedApp, type DesktopAction } from "../desktop";
import { bindSession } from "../session-services";
import type { AppContext, HostServices } from "../sdk";
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
  const context: AppContext = {
    session: workspace.session,
    services: binding.services,
    preview,
    active,
    connect,
    reportError,
    openApp: (id, launch) => dispatch({ type: "new", id, launch }),
  };
  return (
    <div
      className="workspace-windows"
      hidden={!active}
      inert={!active}
      aria-label={`${workspace.label} workspace`}
    >
      {Object.keys(workspace.desktop.instances).map((id) => {
        const instance = workspace.desktop.instances[id];
        const app = apps.find((app) => app.id === instance.appId)!;
        return (
          <AppWindow
            key={id}
            app={app}
            title={
              instance.ordinal > 1
                ? `${app.title} ${instance.ordinal}`
                : app.title
            }
            cascade={instance.ordinal - 1}
            context={{
              ...context,
              active: active && !workspace.desktop.minimized.includes(id),
              launch: instance.launch,
            }}
            focused={active && focusedApp(workspace.desktop) === id}
            focus={() => dispatch({ type: "focus", id })}
            visible={active && !workspace.desktop.minimized.includes(id)}
            order={workspace.desktop.open.indexOf(id)}
            minimize={() => dispatch({ type: "minimize", id })}
            close={() => dispatch({ type: "close", id })}
          />
        );
      })}
    </div>
  );
}
