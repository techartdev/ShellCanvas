// SPDX-License-Identifier: MPL-2.0
import { useEffect, useMemo, useRef, useState } from "react";
import { Package, PanelsTopLeft } from "lucide-react";
import type { DesktopAction, DesktopState } from "../desktop";
import {
  capabilityLabels,
  type AppContext,
  type Capability,
  type DesktopApp,
} from "../sdk";
import type { SystemAPI } from "../system-api";
import { AppCatalog, type AppLease, type InstalledApp } from "./catalog";
import { ExtensionManager } from "./ExtensionManager";
import { ExtensionFrame } from "./ExtensionFrame";

function descriptor(
  entry: InstalledApp,
  component: DesktopApp["component"],
): DesktopApp {
  const capabilities = entry.grants.filter((grant): grant is Capability =>
    Object.hasOwn(capabilityLabels, grant),
  );
  return {
    apiVersion: 1,
    id: entry.package.id,
    title: entry.package.title,
    subtitle: `Version ${entry.package.version}`,
    scope: capabilities.length ? "host" : "local",
    requires: [],
    optional: capabilities,
    icon: PanelsTopLeft,
    component,
    window: { multiple: true },
  };
}

/** Stable window/channel; a new host generation requires an explicit user switch. */
function RuntimeDocument({
  lease,
  retain,
  context,
}: {
  lease: AppLease;
  retain(): () => void;
  context: AppContext;
}) {
  const [accepted, accept] = useState(context.system);
  const target = useRef(accepted);
  target.current = accepted;
  const system = useMemo<SystemAPI>(
    () => ({
      apiVersion: 1,
      dialogs: {
        messageBox: (...args) => target.current!.dialogs.messageBox(...args),
        openFile: (...args) => target.current!.dialogs.openFile(...args),
        saveFile: (...args) => target.current!.dialogs.saveFile(...args),
      },
      files: {
        saveTextAs: (...args) => target.current!.files.saveTextAs(...args),
      },
    }),
    [],
  );
  useEffect(retain, [retain]);
  return (
    <div className="runtime-document">
      {accepted !== context.system && (
        <div className="runtime-connection-review" role="status">
          <span>Your draft is preserved. This host has a new connection.</span>
          <button
            disabled={!context.connected}
            onClick={() => accept(context.system)}
          >
            Use reconnected host
          </button>
        </div>
      )}
      <div className="runtime-document-content">
        <ExtensionFrame
          app={lease.installed.package}
          grants={lease.installed.grants}
          lease={lease}
          system={system}
          onDocumentState={context.setDocumentState}
        />
      </div>
    </div>
  );
}

/** Desktop-owned catalog and live leases. React reducers remain free of resource mutations. */
export class DesktopRuntime {
  private live = new Map<
    string,
    { lease: AppLease; app: DesktopApp; mounts: number }
  >();
  private current: readonly DesktopApp[];
  private listeners = new Set<() => void>();
  private manager: DesktopApp;
  constructor(
    readonly catalog: AppCatalog,
    private bundled: readonly DesktopApp[],
  ) {
    this.manager = {
      apiVersion: 1,
      id: "apps",
      title: "Apps",
      subtitle: "Install and manage your desktop tools",
      scope: "local",
      requires: [],
      icon: Package,
      component: (context) => (
        <ExtensionManager
          catalog={catalog}
          open={(id) => context.openApp?.(id)}
        />
      ),
    };
    this.current = [...bundled, this.manager];
    catalog.subscribe(this.refresh);
  }
  private refresh = () => {
    const installed = this.catalog.snapshot();
    const ids = new Set(this.bundled.map((app) => app.id));
    ids.add(this.manager.id);
    const additions: DesktopApp[] = [];
    for (const entry of installed) {
      if (ids.has(entry.package.id)) continue;
      ids.add(entry.package.id);
      additions.push(descriptor(entry, () => null));
    }
    // A catalog refresh cannot remove a running app's launcher/restore affordance.
    for (const { app } of this.live.values())
      if (!ids.has(app.id)) {
        ids.add(app.id);
        additions.push(app);
      }
    this.current = [...this.bundled, this.manager, ...additions];
    for (const listener of this.listeners) listener();
  };
  snapshot = () => this.current;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  disabledReason(id: string) {
    if (this.bundled.some((app) => app.id === id) || id === this.manager.id)
      return undefined;
    return this.catalog
      .snapshot()
      .some((entry) => entry.package.id === id && entry.enabled)
      ? undefined
      : "This app is disabled or no longer installed.";
  }
  prepare(action: DesktopAction, state: DesktopState): DesktopAction {
    if (action.type !== "open" && action.type !== "new") return action;
    if (
      this.bundled.some((app) => app.id === action.id) ||
      action.id === this.manager.id
    )
      return action;
    if (action.type === "open") {
      const existing = state.open
        .filter((id) => state.instances[id].appId === action.id)
        .at(-1);
      if (existing) return { type: "focus", id: existing };
    }
    const lease = this.catalog.launch(action.id);
    const retain = () => {
      const record = this.live.get(lease.id)!;
      record.mounts++;
      return () => {
        record.mounts--;
        // StrictMode's synthetic cleanup is followed by another setup in the same turn.
        queueMicrotask(() => {
          if (!record.mounts) this.close(lease.id);
        });
      };
    };
    const app = descriptor(lease.installed, (context) => (
      <RuntimeDocument lease={lease} retain={retain} context={context} />
    ));
    this.live.set(lease.id, { lease, app, mounts: 0 });
    return { type: "new", id: action.id, extension: lease.id };
  }
  resolve(instance: DesktopState["instances"][string]): DesktopApp | undefined {
    return instance.extension
      ? this.live.get(instance.extension)?.app
      : this.current.find((app) => app.id === instance.appId);
  }
  close(id: string) {
    const record = this.live.get(id);
    if (!record) return;
    this.live.delete(id);
    record.lease.close();
  }
  closeAll() {
    for (const id of this.live.keys()) this.close(id);
  }
}
