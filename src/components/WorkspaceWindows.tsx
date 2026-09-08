// SPDX-License-Identifier: MPL-2.0
import { useLayoutEffect, useMemo } from "react";
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
  // Switching keeps the handle. An explicit reconnect gets a fresh generation.
  const binding = useMemo(
    () => bindSession(backend, workspace.session),
    [backend, workspace.session?.id],
  );
  useLayoutEffect(() => {
    if (workspace.connected !== false) binding.activate();
    else binding.dispose();
    return binding.dispose;
  }, [binding, workspace.connected]);
  const context: AppContext = {
    session: workspace.session,
    services: binding.services,
    preview,
    active,
    connect,
    reportError,
    openApp: (id, launch) => dispatch({ type: "new", id, launch }),
    connected: workspace.connected !== false,
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
              instance.title ||
              (instance.ordinal > 1
                ? `${app.title} ${instance.ordinal}`
                : app.title)
            }
            dirty={instance.dirty}
            busy={instance.busy}
            cascade={instance.ordinal - 1}
            context={{
              ...context,
              active: active && !workspace.desktop.minimized.includes(id),
              launch: instance.launch,
              setDocumentState: (state) =>
                dispatch({ type: "document-state", id, ...state }),
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
