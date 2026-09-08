// SPDX-License-Identifier: MPL-2.0
import { useEffect, useMemo, useState } from "react";
import { PanelsTopLeft } from "lucide-react";
import { AppWindow } from "../components/AppWindow";
import {
  capabilityLabels,
  type AppContext,
  type Capability,
  type DesktopApp,
} from "../sdk";
import type { AppLease } from "./catalog";
import type { AppDocumentState } from "./window-api";
import { ExtensionFrame } from "./ExtensionFrame";

/** Reuses the desktop's window chrome, dirty-close review and per-window system scope. */
export function ExtensionWindow({
  lease,
  context,
  close,
  focus,
  focused,
  order = 0,
  visible = true,
  minimize,
}: {
  lease: AppLease;
  context: AppContext;
  close(): void;
  focus(): void;
  focused: boolean;
  order?: number;
  visible?: boolean;
  minimize(): void;
}) {
  const [state, setState] = useState<AppDocumentState>({
    dirty: false,
    busy: false,
  });
  const app = useMemo<DesktopApp>(() => {
    const capabilities = lease.installed.grants.filter(
      (grant): grant is Capability => Object.hasOwn(capabilityLabels, grant),
    );
    return {
      apiVersion: 1,
      id: lease.installed.package.id,
      title: lease.installed.package.title,
      subtitle: `Version ${lease.installed.package.version}`,
      scope: capabilities.length ? "host" : "local",
      requires: [],
      optional: capabilities,
      icon: PanelsTopLeft,
      component: (context) =>
        context.system ? (
          <ExtensionFrame
            app={lease.installed.package}
            grants={lease.installed.grants}
            system={context.system}
            lease={lease}
            onDocumentState={context.setDocumentState}
          />
        ) : null,
      window: { multiple: true },
    };
  }, [lease]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (state.dirty || state.busy) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [state]);
  return (
    <AppWindow
      app={app}
      context={{
        ...context,
        active: context.active !== false && visible,
        setDocumentState: setState,
      }}
      title={`${state.title || app.title} · ${lease.installed.package.version}`}
      dirty={state.dirty}
      busy={state.busy}
      close={close}
      focused={focused}
      focus={focus}
      order={order}
      visible={visible}
      minimize={minimize}
    />
  );
}
