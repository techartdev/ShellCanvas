// SPDX-License-Identifier: MPL-2.0
import { useLayoutEffect, useMemo } from "react";
import type { DesktopRuntime } from "../extensions/desktop-runtime";
import { focusedApp, instanceTitle, type DesktopAction } from "../desktop";
import { WorkspaceBindings } from "../workspace-bindings";
import type { AppContext, HostServices } from "../sdk";
import type { Workspace } from "../workspaces";
import { AppWindow } from "./AppWindow";

export function WorkspaceWindows({
  workspace,
  runtime,
  backend,
  active,
  preview,
  dispatch,
  connect,
  reportError,
}: {
  workspace: Workspace;
  runtime: DesktopRuntime;
  backend: HostServices;
  active: boolean;
  preview: boolean;
  dispatch(action: DesktopAction): void;
  connect(): void;
  reportError(message: string): void;
}) {
  const bindings = useMemo(
    () => new WorkspaceBindings(backend, reportError),
    [backend, workspace.session?.id],
  );
  const plan = useMemo(
    () =>
      bindings.prepare(
        workspace.session,
        new Map(
          Object.entries(workspace.desktop.instances).flatMap(
            ([id, instance]) => {
              const app = runtime.resolve(instance);
              return app ? [[id, app] as const] : [];
            },
          ),
        ),
      ),
    [bindings, workspace.session, workspace.desktop.instances, runtime],
  );
  useLayoutEffect(() => {
    bindings.commit(plan, workspace.connected !== false);
  }, [bindings, plan, workspace.connected]);
  useLayoutEffect(() => () => bindings.dispose(), [bindings]);
  const context: Omit<AppContext, "services"> = {
    session: workspace.session,
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
      onKeyDown={(event) => {
        if (
          event.key !== "F6" ||
          !(event.target as HTMLElement).closest("[data-window-titlebar]")
        )
          return;
        const bars = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            ".app-window:not(.hidden-window) [data-window-titlebar]",
          ),
        );
        const current = bars.indexOf(
          (event.target as HTMLElement).closest<HTMLElement>(
            "[data-window-titlebar]",
          )!,
        );
        if (current < 0 || !bars.length) return;
        event.preventDefault();
        event.stopPropagation();
        bars[
          (current + (event.shiftKey ? -1 : 1) + bars.length) % bars.length
        ].focus();
      }}
    >
      {Object.keys(workspace.desktop.instances).map((id) => {
        const instance = workspace.desktop.instances[id];
        const app = runtime.resolve(instance);
        if (!app) return null;
        return (
          <AppWindow
            key={id}
            app={app}
            title={`${instanceTitle(app, instance)}${instance.extension ? ` · ${app.subtitle}` : ""}`}
            dirty={instance.dirty}
            busy={instance.busy}
            workspaceActive={active}
            cascade={instance.ordinal - 1}
            context={{
              ...context,
              services: plan.windows.get(id)!.record.binding.services,
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
