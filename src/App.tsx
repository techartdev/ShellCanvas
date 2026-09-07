// SPDX-License-Identifier: MPL-2.0
import { useEffect, useReducer, useState } from "react";
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
import { focusedApp, initialDesktop, updateDesktop } from "./desktop";
import { AppWindow } from "./components/AppWindow";
import { ConnectDialog } from "./components/ConnectDialog";
import { native, nativeServices } from "./services";
import { previewServices, previewSession } from "./preview";
import type { AppContext, ConnectOptions, HostProfile, Session } from "./sdk";
import { unavailableReason } from "./sdk";
const services = native ? nativeServices : previewServices;
export default function App() {
  const [session, setSession] = useState<Session | null>(
    native ? null : previewSession,
  );
  const [profiles, setProfiles] = useState<HostProfile[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [label, setLabel] = useState(native ? "No host connected" : "atlas");
  const [desktop, dispatch] = useReducer(
    (
      state: ReturnType<typeof initialDesktop>,
      action: Parameters<typeof updateDesktop>[1],
    ) => updateDesktop(state, action, apps),
    apps,
    initialDesktop,
  );
  const focused = focusedApp(desktop);
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
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 8000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    localStorage.setItem("shellcanvas.wallpaper", wallpaper);
  }, [wallpaper]);
  useEffect(() => {
    if (!native || !session) return;
    let disposed = false;
    const timer = setInterval(() => {
      void services
        .alive(session.id)
        .then((alive) => {
          if (!alive && !disposed) {
            setSession(null);
            setLabel("Connection lost");
            setToast(
              "The SSH connection closed. Reconnect to open a new workspace.",
            );
          }
        })
        .catch((e) => {
          if (!disposed) setToast(String(e));
        });
    }, 4000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [session?.id]);
  async function connect(options: ConnectOptions, name: string) {
    setConnecting(true);
    setError("");
    setSession(null);
    try {
      const result = await services.connect(options);
      setSession(result);
      setLabel(name);
      setConnectOpen(false);
      dispatch({ type: "host-connected" });
      if (result.info.notices.length) setToast(result.info.notices.join(" "));
    } catch (e) {
      setError(String(e));
      setLabel("No host connected");
    } finally {
      setConnecting(false);
    }
  }
  async function disconnect() {
    setSession(null);
    setLabel("No host connected");
    try {
      await services.disconnect();
    } catch (e) {
      setToast(String(e));
    }
  }
  function openApp(id: string) {
    dispatch({ type: "open", id });
    setLauncherOpen(false);
  }
  const context: AppContext = {
    session,
    services,
    preview: !native,
    connect: () => {
      setError("");
      setConnectOpen(true);
    },
    reportError: setToast,
  };
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
        <button
          className={`host-pill ${session ? "connected" : ""}`}
          onClick={context.connect}
        >
          <span className="status-dot" />
          {label}
          <ChevronDown size={12} />
        </button>
        <div className="system-indicators">
          <span className="preview-label">
            {!native
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
              {!native
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
          <button className="workspace-connect" onClick={context.connect}>
            <Plus size={15} />
            {session ? "Switch host" : "Connect a host"}
            <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="desktop-meta">
          <span>
            <ShieldCheck size={13} />
            {session
              ? native
                ? "Known host verified"
                : "No remote connection"
              : "SSH. Nothing extra on your host."}
          </span>
          <span>{session?.info.system || "Terminal · Files · Your space"}</span>
        </div>
        <div className="windows-area">
          {apps
            .filter((app) => desktop.open.includes(app.id))
            .map((app) => (
              <AppWindow
                key={app.id}
                app={app}
                context={context}
                focused={focused === app.id}
                focus={() => dispatch({ type: "focus", id: app.id })}
                visible={!desktop.minimized.includes(app.id)}
                order={desktop.open.indexOf(app.id)}
                minimize={() => dispatch({ type: "minimize", id: app.id })}
                close={() => dispatch({ type: "close", id: app.id })}
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
              context.connect();
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
            ? !native
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
            onClick={context.connect}
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
          disabled={!session || !native}
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
          preview={!native}
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
