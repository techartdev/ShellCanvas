// SPDX-License-Identifier: MPL-2.0
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
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
import { apps } from "./apps/registry";
import type { DesktopAction } from "./desktop";
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
import { SettingsDialog } from "./components/SettingsDialog";
import { usePreferences } from "./preferences";
import { native, nativeServices } from "./services";
import { previewServices, previewSession } from "./preview";
import type {
  ConnectOptions,
  DesktopApp,
  HostProfile,
  HostServices,
  Session,
} from "./sdk";
import { unavailableReason } from "./sdk";
const defaultServices = native ? nativeServices : previewServices;
export default function App({
  services = defaultServices,
  initialSession = native ? null : previewSession,
  isNative = native,
  initialConnection,
}: {
  services?: HostServices;
  initialSession?: Session | null;
  isNative?: boolean;
  initialConnection?: HostProfile;
} = {}) {
  const [workspaces, update] = useReducer(
    (
      state: ReturnType<typeof initialWorkspaces>,
      action: Parameters<typeof updateWorkspaces>[1],
    ) => updateWorkspaces(state, action, apps),
    initialSession,
    (session) => initialWorkspaces(apps, session, initialConnection),
  );
  const workspaceState = useRef(workspaces);
  workspaceState.current = workspaces;
  const workspace = workspaces.items.find((w) => w.key === workspaces.active)!;
  const { session, label, desktop } = workspace;
  const connected = !!session && workspace.connected !== false;
  const [closeWorkspace, setCloseWorkspace] = useState<number | null>(null);
  const [closeApp, setCloseApp] = useState(false);
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
  const dispatch = (action: DesktopAction) =>
    update({ type: "desktop", key: workspace.key, action });
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
  const [connecting, setConnecting] = useState(false);
  const attempt = useRef<AbortController | null>(null);
  const [reconnectTarget, setReconnectTarget] = useState<{
    key: string;
    sessionId: number;
    connection: HostProfile;
  } | null>(null);
  useEffect(
    () => () => {
      attempt.current?.abort();
      attempt.current = null;
    },
    [],
  );
  const [connectOpen, setConnectOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<HostProfile>();
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [clock, setClock] = useState(new Date());
  const { values: preferences } = usePreferences();
  useEffect(() => {
    void services
      .profiles()
      .then(setProfiles)
      .catch((e) => setToast(String(e)));
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, [services]);
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
              const alive = await services.alive(w.session!.id);
              if (!alive && !disposed) {
                update({ type: "lost", sessionId: w.session!.id });
                setToast(
                  `${w.label}: connection closed. Unsaved work remains available in this workspace.`,
                );
                await services.disconnect(w.session!.id);
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
      .map((w) => `${w.key}:${w.session?.id}:${w.connected}`)
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
      !workspace.connection ||
      Object.values(desktop.instances).some((instance) => instance.busy)
    )
      return;
    setReconnectTarget({
      key: workspace.key,
      sessionId: session.id,
      connection: workspace.connection,
    });
    setEditingProfile(workspace.connection);
    setSwitcherOpen(false);
    setError("");
    setConnectOpen(true);
  }
  function cancelConnection() {
    attempt.current?.abort();
    attempt.current = null;
    setConnecting(false);
    setError("Connection canceled. You can try again.");
  }
  async function connect(options: ConnectOptions, name: string) {
    const profile = connectionProfile(options, name);
    const target = reconnectTarget;
    if (target && !sameEndpoint(target.connection, profile)) {
      setError(
        "Reconnect uses the original host, port and user. Use Add host for a different connection.",
      );
      return;
    }
    attempt.current?.abort();
    const controller = new AbortController();
    attempt.current = controller;
    setConnecting(true);
    setError("");
    try {
      const result = await services.connect(options, controller.signal);
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
      setReconnectTarget(null);
      if (result.info.notices.length) setToast(result.info.notices.join(" "));
    } catch (e) {
      if (attempt.current === controller && !controller.signal.aborted)
        setError(String(e));
    } finally {
      if (attempt.current === controller) {
        attempt.current = null;
        setConnecting(false);
      }
    }
  }
  async function disconnect() {
    if (!session) return;
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
    update({ type: "remove", sessionId: id });
    try {
      await services.disconnect(id);
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
          disabled: !!unavailableReason(app, session),
          run: () => dispatch({ type: "new", id: app.id }),
        },
        ...ids.map((id) => ({
          id,
          label: `${app.title}${desktop.instances[id].ordinal > 1 ? ` ${desktop.instances[id].ordinal}` : ""}${desktop.minimized.includes(id) ? " · Minimized" : ""}`,
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
              disabled: connected || !workspace.connection || !session,
              run: reconnect,
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
                ? "SSH workspace"
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
                ? "Known host verified"
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
              backend={services}
              active={w.key === workspace.key}
              preview={!isNative}
              dispatch={(action) =>
                update({ type: "desktop", key: w.key, action })
              }
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
        <div className="launcher">
          <div className="popover-heading">
            <span>Your workspace</span>
            <button
              className="icon-button"
              aria-label="Close launcher"
              onClick={() => setLauncherOpen(false)}
            >
              <X size={16} />
            </button>
          </div>
          {apps.map((app) => (
            <button
              className="launcher-app"
              key={app.id}
              disabled={
                !!session &&
                !!unavailableReason(app, session) &&
                !desktop.open.some(
                  (id) => desktop.instances[id].appId === app.id,
                )
              }
              title={unavailableReason(app, session) ?? app.subtitle}
              onClick={() => openApp(app.id)}
            >
              <span className={`dock-app-icon ${app.id}`}>
                <app.icon size={23} />
              </span>
              <span>
                <strong>{app.title}</strong>
                <small>
                  {session
                    ? (unavailableReason(app, session) ?? app.subtitle)
                    : app.subtitle}
                </small>
              </span>
              <ArrowUpRight size={16} />
            </button>
          ))}
          <button
            className="launcher-connect"
            onClick={() => {
              setLauncherOpen(false);
              showConnect();
            }}
          >
            <Plus size={16} />
            Connect another host
          </button>
        </div>
      )}
      {settingsOpen && (
        <SettingsDialog
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
        <span className="bottom-status">
          <Circle size={6} fill="currentColor" />
          {session
            ? !isNative
              ? "Preview mode"
              : connected
                ? "Connected over SSH"
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
          {apps.map((app) => (
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
              <span className={`dock-app-icon ${app.id}`}>
                <app.icon size={25} />
              </span>
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
          disabled={
            !session ||
            !isNative ||
            Object.values(desktop.instances).some((instance) => instance.busy)
          }
          onClick={() => void disconnect()}
        >
          <Power size={13} /> {connected ? "Disconnect" : "Close workspace"}
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
          initialProfile={editingProfile}
          busy={connecting}
          reconnecting={!!reconnectTarget}
          cancelConnect={cancelConnection}
          error={error}
          preview={!isNative}
          save={async (profile) => {
            const saved = await services.saveProfile(profile);
            setProfiles(await services.profiles());
            return saved;
          }}
          remove={async (id) => {
            await services.removeProfile(id);
            setProfiles(await services.profiles());
          }}
          close={() => setConnectOpen(false)}
          submit={(options, name) => void connect(options, name)}
        />
      )}
      {menu && <ContextMenu {...menu} close={closeMenu} />}
      {closeWorkspace !== null && (
        <ConfirmDialog
          title="Close workspace with unsaved changes?"
          message="Unsaved drafts and proposed settings in this workspace will be discarded. Save or copy your changes before disconnecting."
          confirmLabel="Discard and disconnect"
          confirm={() => void disconnectWorkspace(closeWorkspace)}
          cancel={() => setCloseWorkspace(null)}
        />
      )}
      {closeApp && (
        <ConfirmDialog
          title={
            hasBusy
              ? "A file operation is still running"
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
    </main>
  );
}
