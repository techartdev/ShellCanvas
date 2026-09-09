// SPDX-License-Identifier: MPL-2.0
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Package, PanelsTopLeft } from "lucide-react";
import type { DesktopAction, DesktopState } from "../desktop";
import {
  capabilityLabels,
  capabilityReason,
  type AppContext,
  type Capability,
  type DesktopApp,
} from "../sdk";
import type { SystemAPI } from "../system-api";
import { AppCatalog, type AppLease, type InstalledApp } from "./catalog";
import { ExtensionCenter } from "./ExtensionCenter";
import { defaultAdapterServices, type AdapterServices } from "../adapters";
import { ExtensionFrame } from "./ExtensionFrame";
import { indexedAppStorage } from "./app-storage";
import type { AppStorageBackend } from "./storage-api";
import { RuntimeEnvironment } from "./environment";
import type { AppEnvironment } from "./environment-api";
import type { CustomAccess } from "../custom-services";
import { RpcError } from "./rpc";
import type { AppFileSourceGetter } from "./file-bridge";
import type { AppConsoleSourceGetter } from "./console-bridge";
import type { AppTransferSourceGetter } from "./transfer-bridge";
import type { AppHostSettingsSourceGetter } from "./host-settings-bridge";
import { appCapabilities } from "./permissions";
import {
  clipboard as systemClipboard,
  type ClipboardService,
} from "../clipboard";

function descriptor(
  entry: InstalledApp,
  component: DesktopApp["component"],
): DesktopApp {
  const capabilities = appCapabilities(entry.grants);
  return {
    apiVersion: 1,
    id: entry.package.id,
    title: entry.package.title,
    subtitle: `Version ${entry.package.version}`,
    scope: capabilities.length ? "host" : "local",
    requires: [],
    optional: capabilities,
    customPermissions: entry.grants.filter((grant) =>
      grant.startsWith("services."),
    ),
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
  storage,
  clipboard,
}: {
  lease: AppLease;
  retain(): () => void;
  context: AppContext;
  storage: AppStorageBackend;
  clipboard: ClipboardService;
}) {
  const [accepted, accept] = useState(context.system);
  const [acceptedServices, acceptServices] = useState(context.services);
  const [acceptedCustom, acceptCustom] = useState(context.services.custom);
  const customTarget = useRef(acceptedCustom);
  customTarget.current = acceptedCustom;
  const custom = useMemo<CustomAccess>(
    () => ({
      list: async (signal) =>
        customTarget.current ? customTarget.current.list(signal) : [],
      async call(binding, method, params, signal) {
        const original = customTarget.current;
        if (!original)
          throw new RpcError(
            "unavailable",
            "No custom services in this workspace",
          );
        const result = await original.call(binding, method, params, signal);
        if (original !== customTarget.current)
          throw new RpcError(
            "closed",
            "Service connection changed; the remote outcome may be uncertain. Inspect before retrying.",
          );
        return result;
      },
    }),
    [],
  );
  const target = useRef(accepted);
  target.current = accepted;
  const identities = useRef(new WeakMap<SystemAPI, string>());
  const currentBinding = () => {
    if (!accepted || !context.session) return null;
    let id = identities.current.get(accepted);
    if (!id) {
      id = crypto.randomUUID();
      identities.current.set(accepted, id);
    }
    return id;
  };
  const state: AppEnvironment = {
    apiVersion: 1,
    connection: !context.session
      ? "local"
      : !context.connected
        ? "disconnected"
        : accepted !== context.system
          ? "review-required"
          : "connected",
    binding: currentBinding(),
    visible: context.visible !== false,
    capabilities: context.session
      ? (Object.keys(capabilityLabels) as Capability[]).filter(
          (capability) => !capabilityReason(context.session!, capability),
        )
      : [],
    operations: Object.fromEntries(
      (context.session?.services ?? [])
        .filter((item) => item.operations !== undefined)
        .map((item) => [item.capability, item.operations!]),
    ),
  };
  const fileTarget = useRef({
    binding: state.binding,
    services: acceptedServices,
  });
  fileTarget.current = { binding: state.binding, services: acceptedServices };
  const fileSource = useMemo<AppFileSourceGetter>(
    () => () => {
      const current = fileTarget.current;
      return current.binding
        ? { binding: current.binding, services: current.services }
        : undefined;
    },
    [],
  );
  const [environment] = useState(() => new RuntimeEnvironment(state));
  const transferSource = useMemo<AppTransferSourceGetter>(
    () => () => {
      const current = fileTarget.current;
      return current.binding
        ? { binding: current.binding, services: current.services }
        : undefined;
    },
    [],
  );
  const consoleSource = useMemo<AppConsoleSourceGetter>(
    () => () => {
      const current = fileTarget.current;
      return current.binding
        ? { binding: current.binding, services: current.services }
        : undefined;
    },
    [],
  );
  const hostSettingsSource = useMemo<AppHostSettingsSourceGetter>(
    () => () => {
      const current = fileTarget.current;
      return current.binding
        ? { binding: current.binding, services: current.services }
        : undefined;
    },
    [],
  );
  useLayoutEffect(() => environment.update(state));
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
            onClick={() => {
              accept(context.system);
              acceptServices(context.services);
              acceptCustom(context.services.custom);
            }}
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
          windowControls={context.window}
          storage={storage}
          clipboard={clipboard}
          environment={environment}
          custom={custom}
          fileSource={fileSource}
          consoleSource={consoleSource}
          transferSource={transferSource}
          hostSettingsSource={hostSettingsSource}
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
    private storage: AppStorageBackend = indexedAppStorage(),
    private clipboard: ClipboardService = systemClipboard,
    private adapters: AdapterServices | undefined = defaultAdapterServices,
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
        <ExtensionCenter
          catalog={catalog}
          adapters={this.adapters}
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
      <RuntimeDocument
        lease={lease}
        retain={retain}
        context={context}
        storage={this.storage}
        clipboard={this.clipboard}
      />
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
