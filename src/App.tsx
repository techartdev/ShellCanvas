// SPDX-License-Identifier: MPL-2.0
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Circle,
  Command,
  Grid2X2,
  Moon,
  Plus,
  Power,
  Server,
  Settings2,
  ShieldCheck,
  Sun,
  Wifi,
  X,
} from "lucide-react";
import { apps } from "./apps/registry";
import type { DesktopAction } from "./desktop";
import { initialWorkspaces, updateWorkspaces } from "./workspaces";
import { WorkspaceWindows } from "./components/WorkspaceWindows";
import { ConnectDialog } from "./components/ConnectDialog";
import { native, nativeServices } from "./services";
import { previewServices, previewSession } from "./preview";
import type { ConnectOptions, HostProfile, HostServices, Session } from "./sdk";
import { unavailableReason } from "./sdk";
const defaultServices = native ? nativeServices : previewServices;
export default function App({
  services = defaultServices,
  initialSession = native ? null : previewSession,
  isNative = native,
}: {
  services?: HostServices;
  initialSession?: Session | null;
  isNative?: boolean;
} = {}) {
  const [workspaces, update] = useReducer(
    (
      state: ReturnType<typeof initialWorkspaces>,
      action: Parameters<typeof updateWorkspaces>[1],
    ) => updateWorkspaces(state, action, apps),
    initialSession,
    (session) => initialWorkspaces(apps, session),
  );
  const workspace = workspaces.items.find((w) => w.key === workspaces.active)!;
  const { session, label, desktop } = workspace;
  const dispatch = (action: DesktopAction) =>
    update({ type: "desktop", key: workspace.key, action });
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcher = useRef<HTMLDivElement>(null);
  const [profiles, setProfiles] = useState<HostProfile[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [clock, setClock] = useState(new Date());
  const [wallpaper, setWallpaper] = useState(
    () =>
      localStorage.getItem("shellcanvas.wallpaper") ||
      localStorage.getItem("sshdesktop.wallpaper") ||
      "fjord",
  );
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
    localStorage.setItem("shellcanvas.wallpaper", wallpaper);
  }, [wallpaper]);
  useEffect(() => {
    if (!isNative) return;
    let disposed = false;
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void Promise.all(
        workspaces.items
          .filter((w) => w.session)
          .map(async (w) => {
            try {
              const alive = await services.alive(w.session!.id);
              if (!alive && !disposed) {
                update({ type: "remove", sessionId: w.session!.id });
                setToast(
                  `${w.label}: connection closed. Other workspaces remain connected.`,
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
  }, [isNative, services, workspaces.items.map((w) => w.key).join(",")]);
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
    setSwitcherOpen(false);
    setError("");
    setConnectOpen(true);
  }, []);
  async function connect(options: ConnectOptions, name: string) {
    setConnecting(true);
    setError("");
    try {
      const result = await services.connect(options);
      update({
        type: "connected",
        session: result,
        label: name || result.info.hostname,
      });
      setConnectOpen(false);
      if (result.info.notices.length) setToast(result.info.notices.join(" "));
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  }
  async function disconnect() {
    if (!session) return;
    const id = session.id;
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
  return (
    <main className={`desktop wallpaper-${wallpaper}`}>
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
            className={`host-pill ${session ? "connected" : ""}`}
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
                  {workspaces.items.filter((w) => w.session).length} connected
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
                        ? `${w.session.info.hostname} · Session ${w.session.id}`
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
              : session
                ? "SSH workspace"
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
          <button className="workspace-connect" onClick={showConnect}>
            <Plus size={15} />
            {session ? "Add host" : "Connect a host"}
            <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="desktop-meta">
          <span>
            <ShieldCheck size={13} />
            {session
              ? isNative
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
              disabled={!!session && !!unavailableReason(app, session)}
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
        <div className="settings-popover">
          <div className="popover-heading">
            <span>
              <Settings2 size={16} /> Desktop settings
            </span>
            <button
              className="icon-button"
              aria-label="Close settings"
              onClick={() => setSettingsOpen(false)}
            >
              <X size={16} />
            </button>
          </div>
          <p className="eyebrow">WALLPAPER</p>
          <div className="wallpaper-options">
            {["fjord", "dusk", "sage"].map((name) => (
              <button
                key={name}
                className={`wallpaper-swatch swatch-${name}`}
                aria-label={`${name} wallpaper`}
                onClick={() => setWallpaper(name)}
              >
                {wallpaper === name && <Check size={20} />}
                <span>{name}</span>
              </button>
            ))}
          </div>
          <div className="settings-detail">
            <Moon size={15} />
            <span>Midnight interface</span>
          </div>
          <div className="settings-detail">
            <Sun size={15} />
            <span>Clock uses your local timezone</span>
          </div>
          <p className="settings-note">
            ShellCanvas 0.1 · Early prototype
            <br />
            Bundled apps · Linux provider · MPL-2.0
          </p>
        </div>
      )}
      <footer className="bottom-bar">
        <span className="bottom-status">
          <Circle size={6} fill="currentColor" />
          {session
            ? !isNative
              ? "Preview mode"
              : "Connected over SSH"
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
              disabled={!!session && !!unavailableReason(app, session)}
              className={desktop.open.includes(app.id) ? "running" : ""}
              onClick={() => openApp(app.id)}
            >
              <span className={`dock-app-icon ${app.id}`}>
                <app.icon size={25} />
              </span>
              <span className="dock-tooltip">{app.title}</span>
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
          disabled={!session || !isNative}
          onClick={() => void disconnect()}
        >
          <Power size={13} /> Disconnect
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
          busy={connecting}
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
    </main>
  );
}
