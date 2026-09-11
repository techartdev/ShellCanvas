// SPDX-License-Identifier: MPL-2.0
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Circle,
  Command,
  Grid2X2,
  Plus,
  Power,
  RotateCcw,
  Server,
  Settings2,
  ShieldCheck,
  Wifi,
  X,
} from "lucide-react";
import { apps as bundledApps } from "./apps/registry";
import { AppCatalog, indexedCatalogStorage } from "./extensions/catalog";
import { DesktopRuntime } from "./extensions/desktop-runtime";
import "./extensions/desktop-runtime.css";
import { instanceTitle, type DesktopAction } from "./desktop";
import {
  connectionProfile,
  initialWorkspaces,
  sameEndpoint,
  updateWorkspaces,
} from "./workspaces";
import { WorkspaceWindows } from "./components/WorkspaceWindows";
import { ContextMenu, type MenuAction } from "./components/ContextMenu";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ConnectDialog } from "./components/ConnectDialog";
import { ConnectAdapterDialog } from "./components/ConnectAdapterDialog";
import {
  defaultAdapterServices,
  type AdapterServices,
  type AdapterProfile,
  type AdapterConnectionOptions,
} from "./adapters";
import { isAdapterProfile, type WorkspaceConnection } from "./workspaces";
import { SettingsDialog } from "./components/SettingsDialog";
import { usePreferences } from "./preferences";
import { useDesktopTheme } from "./themes/runtime";
import { native, nativeServices } from "./services";
import { previewServices, previewSession } from "./preview";
import type {
  ConnectOptions,
  DesktopApp,
  HostProfile,
  HostServices,
  HostKeyChallenge,
  Session,
  ConnectionIdentity,
} from "./sdk";
import { unavailableReason } from "./sdk";
import { SystemDialogHost } from "./components/SystemDialogHost";
import { AppLauncher } from "./components/AppLauncher";
import { AppIcon } from "./components/AppIcon";
const defaultServices = native ? nativeServices : previewServices;
export default function App({
  services = defaultServices,
  initialSession = native ? null : previewSession,
  isNative = native,
  initialConnection,
  appRuntime,
  adapterServices = defaultAdapterServices,
}: {
  services?: HostServices;
  initialSession?: Session | null;
  isNative?: boolean;
  initialConnection?: WorkspaceConnection;
  appRuntime?: DesktopRuntime;
  adapterServices?: AdapterServices;
} = {}) {
  const [runtime] = useState(
    () =>
      appRuntime ??
      new DesktopRuntime(
        new AppCatalog(
          indexedCatalogStorage(
            isNative ? "shellcanvas-runtime-apps" : "shellcanvas-preview-apps",
          ),
        ),
        bundledApps,
        undefined,
        undefined,
        adapterServices,
      ),
  );
  const apps = useSyncExternalStore(runtime.subscribe, runtime.snapshot);
  const [workspaces, update] = useReducer(
    (
      state: ReturnType<typeof initialWorkspaces>,
      action: Parameters<typeof updateWorkspaces>[1],
    ) => updateWorkspaces(state, action, runtime.snapshot()),
    initialSession,
    (session) => initialWorkspaces(apps, session, initialConnection),
  );
  const workspaceState = useRef(workspaces);
  workspaceState.current = workspaces;
  const workspace = workspaces.items.find((w) => w.key === workspaces.active)!;
  const { session, label, desktop } = workspace;
  const connected = !!session && workspace.connected !== false;
  const sshWorkspace =
    !!session?.connections?.length &&
    session.connections.every((source) => source.adapter === "ssh");
  const partiallyAvailable =
    connected &&
    session?.services?.some(
      (service) =>
        service.state === "disconnected" ||
        service.state === "denied" ||
        service.state === "checking",
    );
  const [closeWorkspace, setCloseWorkspace] = useState<number | null>(null);
  const [disconnecting, setDisconnecting] = useState<readonly number[]>([]);
  const closingSessions = useRef(new Map<number, Promise<void>>());
  const disconnectBusy = !!session && disconnecting.includes(session.id);
  const [closeApp, setCloseApp] = useState(false);
  const [hostKeyReview, setHostKeyReview] = useState<{
    challenge: HostKeyChallenge;
    decide(approve: boolean): void;
  } | null>(null);
  const closeAllowed = useRef(false);
  const allInstances = workspaces.items.flatMap((w) =>
    Object.values(w.desktop.instances),
  );
  const hasUnsaved = allInstances.some((instance) => instance.dirty);
  const hasBusy = allInstances.some((instance) => instance.busy);
  const closeState = useRef({ hasUnsaved, hasBusy });
  closeState.current = { hasUnsaved, hasBusy };
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (
        !closeAllowed.current &&
        (closeState.current.hasUnsaved || closeState.current.hasBusy)
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    if (native)
      void import("@tauri-apps/api/window")
        .then(async ({ getCurrentWindow }) => {
          const stop = await getCurrentWindow().onCloseRequested((event) => {
            if (
              !closeAllowed.current &&
              (closeState.current.hasUnsaved || closeState.current.hasBusy)
            ) {
              event.preventDefault();
              setCloseApp(true);
            }
          });
          if (disposed) stop();
          else unlisten = stop;
        })
        .catch((error) => setToast(String(error)));
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);
  const dispatchToWorkspace = (key: string, action: DesktopAction) => {
    const target = workspaceState.current.items.find(
      (item) => item.key === key,
    );
    if (!target) return;
    const apply = (prepared: DesktopAction) => {
      const current = workspaceState.current.items.find(
        (item) => item.key === key,
      );
      if (!current) {
        if (prepared.type === "new" && prepared.extension)
          runtime.close(prepared.extension);
        return;
      }
      if (action.type === "close") {
        const lease = current.desktop.instances[action.id]?.extension;
        if (lease) runtime.close(lease);
      }
      update({ type: "desktop", key, action: prepared });
    };
    try {
      const prepared = runtime.prepare(action, target.desktop);
      if (prepared instanceof Promise)
        void prepared.then(apply).catch((error) => setToast(String(error)));
      else apply(prepared);
    } catch (error) {
      setToast(String(error));
    }
  };
  const dispatch = (action: DesktopAction) =>
    dispatchToWorkspace(workspace.key, action);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    actions: MenuAction[];
    label: string;
  } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useEffect(closeMenu, [workspace.key, closeMenu]);
  const switcher = useRef<HTMLDivElement>(null);
  const [profiles, setProfiles] = useState<HostProfile[]>([]);
  const [profilesError, setProfilesError] = useState("");
  const [profilesLoading, setProfilesLoading] = useState(false);
  const profileRequest = useRef(0);
  const reloadProfiles = useCallback(async () => {
    const request = ++profileRequest.current;
    setProfilesLoading(true);
    setProfilesError("");
    try {
      const saved = await services.profiles();
      if (request === profileRequest.current) setProfiles(saved);
    } catch (error) {
      if (request === profileRequest.current) setProfilesError(String(error));
    } finally {
      if (request === profileRequest.current) setProfilesLoading(false);
    }
  }, [services]);
  const [connecting, setConnecting] = useState(false);
  const attempt = useRef<AbortController | null>(null);
  const [reconnectTarget, setReconnectTarget] = useState<{
    key: string;
    sessionId: number;
    connection: WorkspaceConnection;
  } | null>(null);
  const [sourceTarget, setSourceTarget] = useState<{
    sessionId: number;
    sourceKey: string;
    expected: ConnectionIdentity;
    profile: AdapterProfile;
  } | null>(null);
  const sourceAttempt = useRef<{
    sessionId: number;
    controller: AbortController;
  } | null>(null);
  const [replacingSource, setReplacingSource] = useState(false);
  useEffect(
    () => () => {
      attempt.current?.abort();
      sourceAttempt.current?.controller.abort();
      attempt.current = null;
    },
    [],
  );
  const [connectOpen, setConnectOpen] = useState(false);
  const [adapterConnectOpen, setAdapterConnectOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<
    "desktop" | "files"
  >("desktop");
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        const unlisten = await listen("drive-mappings-close-blocked", () => {
          closeAllowed.current = false;
          setCloseApp(false);
          setToast(
            "Detach local drives in Settings → Files before quitting ShellCanvas.",
          );
          setSettingsInitialSection("files");
          setSettingsOpen(true);
        });
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch((e) => setToast(String(e)));
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  const [editingProfile, setEditingProfile] = useState<HostProfile>();
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  useEffect(() => {
    const stop = runtime.catalog.watch((error) => setToast(String(error)));
    return () => {
      stop();
      runtime.closeAll();
    };
  }, [runtime]);
  const launcherApps = apps.filter(
    (app) =>
      !runtime.disabledReason(app.id) ||
      Object.values(desktop.instances).some(
        (instance) => instance.appId === app.id,
      ),
  );
  const dockApps = launcherApps.filter(
    (app) =>
      bundledApps.some((bundled) => bundled.id === app.id) ||
      app.id === "apps" ||
      Object.values(desktop.instances).some(
        (instance) => instance.appId === app.id,
      ),
  );
  const [clock, setClock] = useState(new Date());
  const { values: preferences } = usePreferences();
  useDesktopTheme();
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, [services]);
  useEffect(() => {
    void reloadProfiles();
  }, [connectOpen, reloadProfiles]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 8000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    document.documentElement.classList.toggle(
      "reduce-motion",
      preferences.reduceMotion,
    );
    return () => document.documentElement.classList.remove("reduce-motion");
  }, [preferences.reduceMotion]);
  useEffect(() => {
    if (!isNative) return;
    let disposed = false;
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void Promise.all(
        workspaces.items
          .filter((w) => w.session && w.connected !== false)
          .map(async (w) => {
            try {
              const status = services.status
                ? await services.status(w.session!.id)
                : undefined;
              const alive =
                status === undefined
                  ? await services.alive(w.session!.id)
                  : !!status?.connected;
              const current = workspaceState.current.items.find(
                (item) => item.session?.id === w.session!.id,
              );
              if (
                !current?.session ||
                sourceAttempt.current?.sessionId === w.session!.id ||
                (current.session.sourceRevision ?? 0) !==
                  (w.session!.sourceRevision ?? 0) ||
                (status &&
                  (status.sourceRevision ?? 0) !==
                    (current.session.sourceRevision ?? 0))
              )
                return;
              if (status && !disposed)
                update({ type: "status", sessionId: w.session!.id, status });
              if (!alive && !disposed) {
                update({ type: "lost", sessionId: w.session!.id });
                setToast(
                  `${w.label}: connection closed. Unsaved work remains available in this workspace.`,
                );
                await releaseSession(w.session!.id);
              }
            } catch (e) {
              if (!disposed) setToast(String(e));
            }
          }),
      ).finally(() => {
        checking = false;
      });
    }, 4000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [
    isNative,
    services,
    workspaces.items
      .map(
        (w) =>
          `${w.key}:${w.session?.id}:${w.connected}:${w.session?.sourceRevision}`,
      )
      .join(","),
  ]);
  useEffect(() => {
    if (!switcherOpen) return;
    const outside = (event: PointerEvent) => {
      if (!switcher.current?.contains(event.target as Node))
        setSwitcherOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSwitcherOpen(false);
        switcher.current
          ?.querySelector<HTMLButtonElement>(".host-pill")
          ?.focus();
      }
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape);
    };
  }, [switcherOpen]);
  const showConnect = useCallback(() => {
    setReconnectTarget(null);
    setSwitcherOpen(false);
    setEditingProfile(undefined);
    setError("");
    setConnectOpen(true);
  }, []);
  function reconnect() {
    if (
      !session ||
      connected ||
      disconnectBusy ||
      !workspace.connection ||
      Object.values(desktop.instances).some((instance) => instance.busy)
    )
      return;
    setReconnectTarget({
      key: workspace.key,
      sessionId: session.id,
      connection: workspace.connection,
    });
    if (isAdapterProfile(workspace.connection)) {
      setSwitcherOpen(false);
      setError("");
      setAdapterConnectOpen(true);
      return;
    }
    setEditingProfile(workspace.connection);
    setSwitcherOpen(false);
    setError("");
    setConnectOpen(true);
  }
  function chooseSource(sourceKey: string) {
    if (
      !session ||
      !connected ||
      !workspace.connection ||
      !isAdapterProfile(workspace.connection) ||
      !adapterServices?.replaceSource ||
      replacingSource ||
      disconnectBusy ||
      Object.values(desktop.instances).some((item) => item.busy)
    )
      return;
    const index = workspace.connection.sources.findIndex(
      (source) => source.key === sourceKey,
    );
    const expected = session.connections?.[index];
    if (!expected) return;
    const profile = {
      ...workspace.connection,
      sources: [workspace.connection.sources[index]],
      bindings: Object.fromEntries(
        Object.entries(workspace.connection.bindings).filter(
          ([, key]) => key === sourceKey,
        ),
      ),
    };
    setSourceTarget({ sessionId: session.id, sourceKey, expected, profile });
    setSwitcherOpen(false);
    setError("");
  }
  async function replaceSource(
    options: AdapterConnectionOptions,
    profile: AdapterProfile,
  ) {
    const target = sourceTarget;
    if (!target || !adapterServices?.replaceSource || sourceAttempt.current)
      return;
    const controller = new AbortController();
    sourceAttempt.current = { sessionId: target.sessionId, controller };
    setReplacingSource(true);
    setError("");
    let releaseReview = () => {};
    try {
      const result = await adapterServices.replaceSource(
        target.sessionId,
        target.expected,
        options,
        controller.signal,
        (challenge) =>
          new Promise<boolean>((resolve) => {
            if (controller.signal.aborted) {
              resolve(false);
              return;
            }
            let settled = false;
            const decide = (approve: boolean) => {
              if (settled) return;
              settled = true;
              controller.signal.removeEventListener("abort", cancel);
              setHostKeyReview(null);
              resolve(approve);
            };
            const cancel = () => decide(false);
            releaseReview = cancel;
            controller.signal.addEventListener("abort", cancel, { once: true });
            setHostKeyReview({ challenge, decide });
          }),
      );
      update({
        type: "source-replaced",
        sessionId: target.sessionId,
        sourceKey: target.sourceKey,
        expected: target.expected,
        profile,
        result,
      });
      setSourceTarget(null);
      setToast(
        result.cleanupWarning ||
          "Connection replaced. Other connections remain open.",
      );
    } catch (error) {
      setError(String(error));
    } finally {
      releaseReview();
      sourceAttempt.current = null;
      setReplacingSource(false);
    }
  }
  function cancelSourceReplacement() {
    sourceAttempt.current?.controller.abort();
    setError(
      "Canceling connection preparation. A replacement already applied will remain connected.",
    );
  }
  function cancelConnection() {
    attempt.current?.abort();
    attempt.current = null;
    setConnecting(false);
    setError("Connection canceled. You can try again.");
  }
  async function connect(options: ConnectOptions, name: string) {
    return establish(connectionProfile(options, name), (signal, review) =>
      services.connect(options, signal, review),
    );
  }
  async function establish(
    profile: WorkspaceConnection,
    open: (
      signal: AbortSignal,
      review: import("./sdk").HostKeyReviewer,
    ) => Promise<Session>,
  ) {
    const name = profile.name;
    const target = reconnectTarget;
    if (target && !sameEndpoint(target.connection, profile)) {
      setError(
        "Reconnect keeps the original connection settings and service sources. Open a new workspace to use a different device.",
      );
      return;
    }
    attempt.current?.abort();
    const controller = new AbortController();
    attempt.current = controller;
    setConnecting(true);
    setError("");
    let releaseReview = () => {};
    try {
      const result = await open(
        controller.signal,
        (challenge) =>
          new Promise<boolean>((resolve) => {
            if (controller.signal.aborted || attempt.current !== controller) {
              resolve(false);
              return;
            }
            let settled = false;
            const decide = (approve: boolean) => {
              if (settled) return;
              settled = true;
              controller.signal.removeEventListener("abort", cancel);
              if (attempt.current === controller) setHostKeyReview(null);
              resolve(approve);
            };
            const cancel = () => decide(false);
            releaseReview = cancel;
            controller.signal.addEventListener("abort", cancel, { once: true });
            setHostKeyReview({ challenge, decide });
          }),
      );
      if (controller.signal.aborted || attempt.current !== controller) {
        await services.disconnect(result.id);
        return;
      }
      if (target) {
        const current = workspaceState.current.items.find(
          (w) => w.key === target.key,
        );
        if (
          !current ||
          current.session?.id !== target.sessionId ||
          current.connected !== false
        ) {
          await services.disconnect(result.id);
          throw new Error(
            "The previous workspace is no longer available. Open a new connection instead.",
          );
        }
        update({
          type: "reconnected",
          key: target.key,
          previousSessionId: target.sessionId,
          session: result,
          connection: profile,
          label: name || result.info.hostname,
        });
      } else
        update({
          type: "connected",
          session: result,
          label: name || result.info.hostname,
          connection: profile,
        });
      setConnectOpen(false);
      setAdapterConnectOpen(false);
      setReconnectTarget(null);
      if (result.info.notices.length) setToast(result.info.notices.join(" "));
    } catch (e) {
      if (attempt.current === controller && !controller.signal.aborted)
        setError(String(e));
    } finally {
      releaseReview();
      if (attempt.current === controller) {
        attempt.current = null;
        setConnecting(false);
      }
    }
  }
  function releaseSession(id: number): Promise<void> {
    const existing = closingSessions.current.get(id);
    if (existing) return existing;
    setDisconnecting((ids) => [...ids, id]);
    const pending = Promise.resolve()
      .then(() => services.disconnect(id))
      .finally(() => {
        closingSessions.current.delete(id);
        setDisconnecting((ids) => ids.filter((pending) => pending !== id));
      });
    closingSessions.current.set(id, pending);
    return pending;
  }
  async function disconnect() {
    if (!session) return;
    const id = session.id;
    if (closingSessions.current.has(id)) return;
    if (Object.values(desktop.instances).some((instance) => instance.busy))
      return;
    if (connected) {
      try {
        await releaseSession(id);
        update({ type: "lost", sessionId: id });
      } catch (error) {
        setToast(`Could not disconnect: ${error}`);
      }
      return;
    }
    await closeCurrentWorkspace();
  }
  async function closeCurrentWorkspace() {
    if (!session || closingSessions.current.has(session.id)) return;
    const id = session.id;
    if (Object.values(desktop.instances).some((instance) => instance.busy))
      return;
    if (Object.values(desktop.instances).some((instance) => instance.dirty)) {
      setCloseWorkspace(id);
      return;
    }
    await disconnectWorkspace(id);
  }
  async function disconnectWorkspace(id: number) {
    setCloseWorkspace(null);
    const current = workspaceState.current.items.find(
      (item) => item.session?.id === id,
    );
    if (
      !current ||
      closingSessions.current.has(id) ||
      Object.values(current.desktop.instances).some((instance) => instance.busy)
    )
      return;
    try {
      await releaseSession(id);
      update({ type: "remove", sessionId: id });
    } catch (e) {
      setToast(String(e));
    }
  }
  function openApp(id: string) {
    dispatch({ type: "open", id });
    setLauncherOpen(false);
  }
  function dockMenu(app: DesktopApp, x: number, y: number) {
    const ids = desktop.open.filter(
      (id) => desktop.instances[id].appId === app.id,
    );
    setMenu({
      x,
      y,
      label: `${app.title} windows`,
      actions: [
        {
          id: "open",
          label: app.window?.multiple
            ? `New ${app.title} window`
            : `Open ${app.title}`,
          disabled:
            !!unavailableReason(app, session) ||
            !!runtime.disabledReason(app.id),
          run: () => dispatch({ type: "new", id: app.id }),
        },
        ...ids.map((id) => ({
          id,
          label: `${instanceTitle(app, desktop.instances[id])}${desktop.minimized.includes(id) ? " · Minimized" : ""}`,
          run: () => dispatch({ type: "focus", id }),
        })),
      ],
    });
  }
  return (
    <main
      className={`desktop wallpaper-${preferences.wallpaper}`}
      onContextMenu={(event) => {
        if (
          (event.target as HTMLElement).closest(
            ".app-window,.system-bar,.dock,.modal-backdrop,.context-menu,dialog,input,button",
          )
        )
          return;
        event.preventDefault();
        setMenu({
          x: event.clientX,
          y: event.clientY,
          label: "Desktop actions",
          actions: [
            {
              id: "terminal",
              label: "New terminal",
              disabled: !session?.info.capabilities.includes("terminal"),
              run: () => dispatch({ type: "new", id: "terminal" }),
            },
            {
              id: "files",
              label: "New Files window",
              disabled: !session?.info.capabilities.includes("files.read"),
              run: () => dispatch({ type: "new", id: "files" }),
            },
            {
              id: "show-desktop",
              label: "Show / restore desktop",
              run: () => dispatch({ type: "show-desktop" }),
            },
            {
              id: "connect",
              label: "Connect another host",
              separatorBefore: true,
              run: showConnect,
            },
            {
              id: "reconnect",
              label: "Reconnect host",
              disabled:
                connected ||
                disconnectBusy ||
                !workspace.connection ||
                !session ||
                Object.values(desktop.instances).some(
                  (instance) => instance.busy,
                ),
              run: reconnect,
            },
            {
              id: "disconnect",
              label: "Disconnect host",
              disabled:
                !connected ||
                !isNative ||
                disconnectBusy ||
                Object.values(desktop.instances).some(
                  (instance) => instance.busy,
                ),
              run: () => void disconnect(),
            },
            {
              id: "close-workspace",
              label: "Close workspace",
              disabled:
                !session ||
                !isNative ||
                disconnectBusy ||
                Object.values(desktop.instances).some(
                  (instance) => instance.busy,
                ),
              run: () => void closeCurrentWorkspace(),
            },
            {
              id: "settings",
              label: "Desktop settings",
              run: () => setSettingsOpen(true),
            },
          ],
        });
      }}
    >
      <div className="landscape" aria-hidden="true">
        <div className="sky-glow" />
        <div className="mountain mountain-far" />
        <div className="mountain mountain-mid" />
        <div className="mountain mountain-near" />
        <div className="landscape-grain" />
      </div>
      <header className="system-bar">
        <button
          className="brand"
          onClick={() => setLauncherOpen(!launcherOpen)}
          aria-label="Open app launcher"
        >
          <span className="brand-mark">
            <Command size={15} />
          </span>
          ShellCanvas<span className="alpha-tag">PREVIEW</span>
        </button>
        <div className="host-switcher" ref={switcher}>
          <button
            className={`host-pill ${connected ? "connected" : ""}`}
            onClick={() => setSwitcherOpen(!switcherOpen)}
            aria-label="Switch workspace"
            aria-expanded={switcherOpen}
          >
            <span className="status-dot" />
            {label}
            <ChevronDown size={12} />
          </button>
          {switcherOpen && (
            <div className="workspace-switcher" aria-label="Workspaces">
              <div className="popover-heading">
                <span>Workspaces</span>
                <small>
                  {
                    workspaces.items.filter(
                      (w) => w.session && w.connected !== false,
                    ).length
                  }{" "}
                  connected
                </small>
              </div>
              {workspaces.items.map((w) => (
                <button
                  key={w.key}
                  className={`workspace-choice ${w.key === workspace.key ? "selected" : ""}`}
                  aria-pressed={w.key === workspace.key}
                  onClick={() => {
                    update({ type: "select", key: w.key });
                    setSwitcherOpen(false);
                  }}
                >
                  <Server size={17} />
                  <span>
                    <strong>{w.label}</strong>
                    <small>
                      {w.session
                        ? `${w.session.info.hostname} · ${w.connected === false ? "Disconnected" : `Session ${w.session.id}`}`
                        : "On this device"}
                    </small>
                  </span>
                  {w.key === workspace.key && <Check size={15} />}
                </button>
              ))}
              {session &&
                workspace.connection &&
                isAdapterProfile(workspace.connection) &&
                adapterServices?.replaceSource && (
                  <>
                    <div className="popover-heading">
                      <span>Current connections</span>
                    </div>
                    {workspace.connection.sources.map((source) => (
                      <button
                        key={source.key}
                        className="workspace-choice"
                        disabled={
                          !connected ||
                          disconnectBusy ||
                          replacingSource ||
                          Object.values(desktop.instances).some(
                            (item) => item.busy,
                          )
                        }
                        onClick={() => chooseSource(source.key)}
                      >
                        <RotateCcw size={17} />
                        <span>
                          <strong>
                            Replace{" "}
                            {Object.entries(
                              (workspace.connection as AdapterProfile).bindings,
                            )
                              .filter(([, key]) => key === source.key)
                              .map(([role]) =>
                                role === "console"
                                  ? "Terminal"
                                  : role === "files"
                                    ? "Files"
                                    : role === "host.settings"
                                      ? "Remote settings"
                                      : role,
                              )
                              .join(" + ")}{" "}
                            connection
                          </strong>
                          <small>{source.id}</small>
                        </span>
                      </button>
                    ))}
                  </>
                )}
              <button className="launcher-connect" onClick={showConnect}>
                <Plus size={16} /> Connect another host
              </button>
            </div>
          )}
        </div>
        <div className="system-indicators">
          <span className="preview-label">
            {!isNative
              ? "Design preview · sample data"
              : connected
                ? sshWorkspace
                  ? "SSH workspace"
                  : "Remote workspace"
                : session
                  ? "Disconnected workspace"
                  : "Local workspace"}
          </span>
          <Wifi size={15} />
          <span className="bar-divider" />
          <time title="Local device time">
            <span className="clock-date">
              {clock.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </span>
            <b>
              {clock.toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                second: preferences.clockSeconds ? "2-digit" : undefined,
                hour12:
                  preferences.clockFormat === "system"
                    ? undefined
                    : preferences.clockFormat === "12",
              })}
            </b>
          </time>
        </div>
      </header>
      <section className="workspace">
        <div className="desktop-heading">
          <div>
            <p className="eyebrow">
              {!isNative
                ? "DESIGN PREVIEW"
                : session
                  ? "YOUR REMOTE WORKSPACE"
                  : "WELCOME TO YOUR WORKSPACE"}
            </p>
            <h1>
              {session ? (
                <>
                  A little closer to <em>{label}.</em>
                </>
              ) : (
                <>
                  Somewhere remote.
                  <br />
                  <em>Feels like home.</em>
                </>
              )}
            </h1>
          </div>
          <button
            className="workspace-connect"
            disabled={
              !connected &&
              !!workspace.connection &&
              (disconnectBusy ||
                Object.values(desktop.instances).some(
                  (instance) => instance.busy,
                ))
            }
            onClick={
              !connected && workspace.connection ? reconnect : showConnect
            }
          >
            {!connected && workspace.connection ? (
              <RotateCcw size={15} />
            ) : (
              <Plus size={15} />
            )}
            {!connected && workspace.connection
              ? "Reconnect host"
              : session
                ? "Add host"
                : "Connect a host"}
            <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="desktop-meta">
          <span>
            <ShieldCheck size={13} />
            {session
              ? connected && isNative
                ? sshWorkspace
                  ? "Known host verified"
                  : "Workspace connected"
                : "No remote connection"
              : "SSH. Nothing extra on your host."}
          </span>
          <span>{session?.info.system || "Terminal · Files · Your space"}</span>
        </div>
        <div className="windows-area">
          {workspaces.items.map((w) => (
            <WorkspaceWindows
              key={w.key}
              workspace={w}
              runtime={runtime}
              backend={services}
              active={w.key === workspace.key}
              preview={!isNative}
              dispatch={(action) => dispatchToWorkspace(w.key, action)}
              connect={showConnect}
              reportError={setToast}
            />
          ))}
        </div>
        <div className="desktop-caption">
          <span className="caption-line" />
          <p>YOUR DESKTOP. YOUR HOST.</p>
          <span>Built for the places your work lives.</span>
        </div>
      </section>
      {launcherOpen && (
        <AppLauncher
          apps={launcherApps}
          running={(appId) =>
            desktop.open.some((id) => desktop.instances[id].appId === appId)
          }
          blocked={(app) =>
            session &&
            !desktop.open.some((id) => desktop.instances[id].appId === app.id)
              ? (unavailableReason(app, session) ?? undefined)
              : undefined
          }
          launch={openApp}
          close={() => setLauncherOpen(false)}
          connect={showConnect}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          initialSection={settingsInitialSection}
          close={() => setSettingsOpen(false)}
          profiles={profiles}
          session={session}
          connected={connected}
          hostDetails={() => {
            setSettingsOpen(false);
            openApp("host-details");
          }}
          manageHost={(profile) => {
            setReconnectTarget(null);
            setSettingsOpen(false);
            setEditingProfile(profile);
            setError("");
            setConnectOpen(true);
          }}
        />
      )}
      <footer className="bottom-bar">
        <span
          className={`bottom-status ${partiallyAvailable ? "partial-status" : ""}`}
        >
          <Circle size={6} fill="currentColor" />
          {session
            ? !isNative
              ? "Preview mode"
              : connected
                ? partiallyAvailable
                  ? "Some services unavailable"
                  : sshWorkspace
                    ? "Connected over SSH"
                    : "Workspace connected"
                : "Disconnected · drafts preserved"
            : "Ready when you are"}
        </span>
        <nav className="dock" aria-label="Desktop applications">
          <button
            title="App launcher"
            aria-label="App launcher"
            className={launcherOpen ? "active" : ""}
            onClick={() => setLauncherOpen(!launcherOpen)}
          >
            <span className="dock-app-icon launcher-icon">
              <Grid2X2 size={23} />
            </span>
          </button>
          <span className="dock-divider" />
          {dockApps.map((app) => (
            <button
              key={app.id}
              title={
                session
                  ? (unavailableReason(app, session) ?? app.title)
                  : app.title
              }
              aria-label={`Open ${app.title}`}
              disabled={
                !!session &&
                !!unavailableReason(app, session) &&
                !desktop.open.some(
                  (id) => desktop.instances[id].appId === app.id,
                )
              }
              className={
                desktop.open.some(
                  (id) => desktop.instances[id].appId === app.id,
                )
                  ? "running"
                  : ""
              }
              onClick={() => openApp(app.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                dockMenu(app, event.clientX, event.clientY);
              }}
              onKeyDown={(event) => {
                if (
                  event.key !== "ContextMenu" &&
                  !(event.shiftKey && event.key === "F10")
                )
                  return;
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                dockMenu(app, bounds.left, bounds.top);
              }}
            >
              <AppIcon
                id={app.id}
                image={app.image}
                icon={app.icon}
                glyph={25}
              />
              <span className="dock-tooltip">{app.title}</span>
              {desktop.open.filter(
                (id) => desktop.instances[id].appId === app.id,
              ).length > 1 && (
                <span className="dock-count">
                  {
                    desktop.open.filter(
                      (id) => desktop.instances[id].appId === app.id,
                    ).length
                  }
                </span>
              )}
            </button>
          ))}
          <span className="dock-divider" />
          <button
            title="Connections"
            aria-label="Connections"
            onClick={showConnect}
          >
            <span className="dock-app-icon connections">
              <Server size={24} />
            </span>
          </button>
          <button
            title="Desktop settings"
            aria-label="Desktop settings"
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            <span className="dock-app-icon settings">
              <Settings2 size={23} />
            </span>
          </button>
        </nav>
        <button
          className="disconnect-button"
          title={
            connected
              ? "Disconnect the host and keep windows and drafts"
              : "Close this workspace"
          }
          disabled={
            !session ||
            !isNative ||
            disconnectBusy ||
            Object.values(desktop.instances).some((instance) => instance.busy)
          }
          onClick={() => void disconnect()}
        >
          <Power size={13} />{" "}
          {disconnectBusy
            ? "Disconnecting…"
            : connected
              ? "Disconnect"
              : "Close workspace"}
        </button>
      </footer>
      {toast && (
        <div className="toast" role="status">
          <ShieldCheck size={18} />
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {connectOpen && (
        <ConnectDialog
          profiles={profiles}
          profilesError={profilesError}
          profilesLoading={profilesLoading}
          reloadProfiles={() => void reloadProfiles()}
          initialProfile={editingProfile}
          busy={connecting}
          hostKeyReview={hostKeyReview}
          reconnecting={!!reconnectTarget}
          cancelConnect={cancelConnection}
          error={error}
          preview={!isNative}
          save={async (profile) => {
            const saved = await services.saveProfile(profile);
            await reloadProfiles();
            return saved;
          }}
          remove={async (id) => {
            await services.removeProfile(id);
            await reloadProfiles();
          }}
          close={() => setConnectOpen(false)}
          submit={(options, name) => void connect(options, name)}
          openAdapters={
            adapterServices
              ? () => {
                  setConnectOpen(false);
                  setAdapterConnectOpen(true);
                }
              : undefined
          }
        />
      )}
      {adapterConnectOpen && adapterServices && (
        <ConnectAdapterDialog
          hostKeyReview={hostKeyReview}
          services={adapterServices}
          initial={
            reconnectTarget && isAdapterProfile(reconnectTarget.connection)
              ? reconnectTarget.connection
              : undefined
          }
          busy={connecting}
          error={error}
          cancel={cancelConnection}
          close={() => {
            setAdapterConnectOpen(false);
            setReconnectTarget(null);
          }}
          manage={() => {
            setAdapterConnectOpen(false);
            openApp("apps");
          }}
          submit={(options, profile) =>
            establish(profile, (signal, review) =>
              adapterServices.connect(options, signal, review),
            )
          }
        />
      )}
      {sourceTarget && adapterServices && (
        <ConnectAdapterDialog
          hostKeyReview={hostKeyReview}
          services={adapterServices}
          initial={sourceTarget.profile}
          replacing
          busy={replacingSource}
          error={error}
          cancel={cancelSourceReplacement}
          close={() => {
            if (!replacingSource) setSourceTarget(null);
          }}
          manage={() => {
            if (!replacingSource) {
              setSourceTarget(null);
              openApp("apps");
            }
          }}
          submit={replaceSource}
        />
      )}
      {menu && <ContextMenu {...menu} close={closeMenu} />}
      {closeWorkspace !== null && (
        <ConfirmDialog
          title="Close workspace with unsaved changes?"
          disabled={
            disconnecting.includes(closeWorkspace) ||
            workspaces.items.some(
              (item) =>
                item.session?.id === closeWorkspace &&
                Object.values(item.desktop.instances).some(
                  (instance) => instance.busy,
                ),
            )
          }
          message="Unsaved drafts and proposed settings in this workspace will be discarded. Disconnecting a host keeps them; closing this workspace removes them."
          confirmLabel="Discard and close"
          confirm={() => void disconnectWorkspace(closeWorkspace)}
          cancel={() => setCloseWorkspace(null)}
        />
      )}
      {closeApp && (
        <ConfirmDialog
          title={
            hasBusy
              ? "An operation is still running"
              : "Close ShellCanvas with unsaved changes?"
          }
          message={
            hasBusy
              ? "Wait for the operation to finish before closing the app."
              : "Unsaved drafts and proposed settings across all workspaces will be discarded."
          }
          confirmLabel="Discard and quit"
          disabled={hasBusy}
          cancel={() => setCloseApp(false)}
          confirm={() => {
            closeAllowed.current = true;
            void import("@tauri-apps/api/window")
              .then(({ getCurrentWindow }) => getCurrentWindow().close())
              .catch((error) => {
                closeAllowed.current = false;
                setToast(String(error));
              });
          }}
        />
      )}
      <SystemDialogHost />
    </main>
  );
}
