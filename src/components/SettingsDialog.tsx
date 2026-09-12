// SPDX-License-Identifier: MPL-2.0
import { showModal } from "../dialog-compat";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ChevronRight,
  FilePenLine,
  Folder,
  Monitor,
  RotateCcw,
  Server,
  Settings2,
  SquareTerminal,
  X,
} from "lucide-react";
import { usePreferences, type Preferences } from "../preferences";
import { Appearance } from "../themes/Appearance";
import { DriveBridgeSettings } from "./DriveBridgeSettings";
import { ShellCanvasMark } from "./ShellCanvasMark";
import type { HostProfile, Session } from "../sdk";
import "./SettingsDialog.css";

const sections = [
  {
    id: "desktop",
    name: "Desktop",
    icon: Monitor,
    description: "A workspace that feels like yours.",
  },
  {
    id: "terminal",
    name: "Terminal",
    icon: SquareTerminal,
    description: "Make every shell comfortable to work in.",
  },
  {
    id: "editor",
    name: "Text editor",
    icon: FilePenLine,
    description: "Small details for focused work.",
  },
  {
    id: "files",
    name: "Files",
    icon: Folder,
    description: "Choose how you explore remote folders.",
  },
  {
    id: "hosts",
    name: "Hosts",
    icon: Server,
    description: "Your saved connections and this workspace.",
  },
] as const;
type Section = (typeof sections)[number]["id"];
type TogglePreference = {
  [K in keyof Preferences]: Preferences[K] extends boolean ? K : never;
}[keyof Preferences];
function Row({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <div className="preference-row">
      <div>
        <strong>{title}</strong>
        {detail && <p>{detail}</p>}
      </div>
      {children}
    </div>
  );
}
export function SettingsDialog({
  close,
  profiles,
  session,
  connected,
  manageHost,
  hostDetails,
  initialSection = "desktop",
}: {
  close(): void;
  profiles: HostProfile[];
  session: Session | null;
  connected: boolean;
  manageHost(profile?: HostProfile): void;
  hostDetails(): void;
  initialSection?: Section;
}) {
  const { values, set, error, blocked, reset } = usePreferences();
  const [section, setSection] = useState<Section>(initialSection);
  useEffect(() => setSection(initialSection), [initialSection]);
  const [resetOpen, setResetOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = dialog.current!;
    showModal(el);
    return () => {
      el.close();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (panel.current) panel.current.scrollTop = 0;
  }, [section]);
  function toggle(key: TogglePreference, label: string, detail?: string) {
    return (
      <Row title={label} detail={detail}>
        <input
          className="preference-toggle"
          type="checkbox"
          role="switch"
          aria-label={label}
          checked={values[key] === true}
          disabled={blocked}
          onChange={(event) => set(key, event.target.checked)}
        />
      </Row>
    );
  }
  function select<K extends keyof Preferences>(
    key: K,
    label: string,
    options: [Preferences[K], string][],
    detail?: string,
  ) {
    return (
      <Row title={label} detail={detail}>
        <select
          aria-label={label}
          value={String(values[key])}
          disabled={blocked}
          onChange={(event) => {
            const choice = options.find(
              ([value]) => String(value) === event.target.value,
            );
            if (choice) set(key, choice[0]);
          }}
        >
          {!options.some(([value]) => value === values[key]) && (
            <option value={String(values[key])}>{String(values[key])}</option>
          )}
          {options.map(([value, name]) => (
            <option key={String(value)} value={String(value)}>
              {name}
            </option>
          ))}
        </select>
      </Row>
    );
  }
  const info = sections.find((item) => item.id === section)!;
  return createPortal(
    <dialog
      ref={dialog}
      className="preferences-dialog"
      aria-labelledby="preferences-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className="preferences-header">
        <span>
          <Settings2 size={17} />
          <strong id="preferences-title">Settings</strong>
        </span>
        <button
          className="icon-button"
          aria-label="Close settings"
          onClick={close}
        >
          <X size={18} />
        </button>
      </header>
      <div className="preferences-body">
        <nav aria-label="Settings sections" className="preferences-nav">
          <p className="eyebrow">YOUR WORKSPACE</p>
          {sections.map(({ id, name, icon: Icon }) => (
            <button
              key={id}
              aria-current={section === id ? "page" : undefined}
              onClick={() => {
                setSection(id);
                setResetOpen(false);
              }}
            >
              <Icon size={17} />
              {name}
            </button>
          ))}
          <div className="preferences-brand">
            <span className="preferences-brand-mark">
              <ShellCanvasMark size={28} />
            </span>
            <strong>ShellCanvas</strong>
            <small>Your desktop. Your host.</small>
          </div>
        </nav>
        <div className="preferences-panel" ref={panel}>
          <p className="eyebrow">
            {section === "hosts" ? "CONNECTIONS" : "PREFERENCES"}
          </p>
          <h2>{info.name}</h2>
          <p className="preferences-intro">{info.description}</p>
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          {section === "desktop" && (
            <>
              <Appearance />
              <h3>Clock & motion</h3>
              <div className="preferences-group">
                {select(
                  "clockFormat",
                  "Time format",
                  [
                    ["system", "System default"],
                    ["12", "12-hour"],
                    ["24", "24-hour"],
                  ],
                  "Uses this device’s timezone.",
                )}
                {toggle("clockSeconds", "Show seconds")}
                {toggle(
                  "reduceMotion",
                  "Reduce motion",
                  "System accessibility preferences are always respected.",
                )}
              </div>
            </>
          )}
          {section === "terminal" && (
            <>
              <div
                className="terminal-type-preview"
                style={{ fontSize: `${values.terminalFontSize / 13}rem` }}
              >
                <span>you@remote</span>:~$ <b>ls -la</b>
                <i className={`cursor-preview ${values.terminalCursor}`} />
              </div>
              <h3>Text & cursor</h3>
              <div className="preferences-group">
                {select(
                  "terminalFontSize",
                  "Terminal text size",
                  [11, 12, 13, 14, 16, 18, 20, 24].map((size) => [
                    size,
                    `${size} px`,
                  ]),
                )}
                {select("terminalCursor", "Cursor shape", [
                  ["bar", "Bar"],
                  ["block", "Block"],
                  ["underline", "Underline"],
                ])}
                {toggle("terminalBlink", "Blink cursor")}
              </div>
              <h3>History</h3>
              <div className="preferences-group">
                {select(
                  "terminalScrollback",
                  "Scrollback lines",
                  [1000, 3000, 10000, 50000, 100000].map((lines) => [
                    lines,
                    lines.toLocaleString(),
                  ]),
                  "Reducing this limit discards older local output. Your running shells stay connected.",
                )}
              </div>
              <p className="preferences-hint">
                Copy: Ctrl+Shift+C · Paste: Ctrl+Shift+V. Ctrl+C sends an
                interrupt to the remote shell.
              </p>
            </>
          )}
          {section === "editor" && (
            <>
              <div
                className="editor-type-preview"
                style={{ fontSize: `${values.editorFontSize / 13}rem` }}
              >
                <span># A little closer to your code.</span>
                <br />
                workspace = "remote"
              </div>
              <h3>Reading & writing</h3>
              <div className="preferences-group">
                {select(
                  "editorFontSize",
                  "Editor text size",
                  [11, 12, 13, 14, 16, 18, 20, 24].map((size) => [
                    size,
                    `${size} px`,
                  ]),
                )}
                {select("editorIndent", "Tab key inserts", [
                  ["2", "2 spaces"],
                  ["4", "4 spaces"],
                  ["tab", "A tab character"],
                ])}
                {toggle(
                  "editorWrap",
                  "Wrap long lines",
                  "Changes the view without changing file contents.",
                )}
                {toggle(
                  "editorLineNumbers",
                  "Show line numbers",
                  "Shown when word wrap is off.",
                )}
              </div>
              <p className="preferences-hint">
                Preferences apply to open editors. Save remains explicit; drafts
                are never saved automatically.
              </p>
            </>
          )}
          {section === "files" && (
            <>
              <h3>Folder view</h3>
              <div className="preferences-group">
                {toggle(
                  "filesShowHidden",
                  "Show hidden files",
                  "Include names starting with a dot.",
                )}
                {toggle("filesFoldersFirst", "Keep folders first")}
                {select("filesSort", "Sort by", [
                  ["name", "Name"],
                  ["modified", "Modified"],
                  ["size", "Size"],
                ])}
                {toggle("filesDescending", "Descending order")}
                {toggle(
                  "filesCompact",
                  "Compact rows",
                  "Fit more items in the file explorer.",
                )}
              </div>
              <p className="preferences-hint">
                These preferences apply across Files windows. Each window keeps
                its own folder and selection.
              </p>
              <DriveBridgeSettings />
            </>
          )}
          {section === "hosts" && (
            <>
              {session && (
                <>
                  <h3>Current workspace</h3>
                  <button
                    className="preference-host current-host"
                    onClick={hostDetails}
                  >
                    <Server size={22} />
                    <span>
                      <strong>{session.info.hostname}</strong>
                      <small>
                        {connected ? "Connected" : "Disconnected"} ·{" "}
                        {session.info.system} · Details & remote settings
                      </small>
                    </span>
                    <ChevronRight size={17} />
                  </button>
                </>
              )}
              <div className="preferences-section-heading">
                <h3>Saved & imported connections</h3>
                <button onClick={() => manageHost()}>
                  Manage hosts <ChevronRight size={13} />
                </button>
              </div>
              <div className="preference-host-list">
                {profiles.length ? (
                  profiles.map((profile, index) => (
                    <button
                      className="preference-host"
                      key={profile.id ?? `import-${index}`}
                      onClick={() => manageHost(profile)}
                    >
                      <Server size={18} />
                      <span>
                        <strong>{profile.name}</strong>
                        <small>
                          {profile.username}@{profile.host}:{profile.port}
                        </small>
                      </span>
                      <span className="preference-host-source">
                        {profile.id ? "Saved" : "SSH config"}
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  ))
                ) : (
                  <p className="preferences-empty">
                    No saved hosts yet. Add a connection to make your next visit
                    easier.
                  </p>
                )}
              </div>
              <p className="preferences-hint">
                Edit names, addresses and authentication methods in the host
                manager. Passwords and key passphrases are not saved. Connection
                changes apply when you connect again.
              </p>
              <div className="preferences-callout">
                <strong>Remote system settings</strong>
                <p>
                  The host details app shows detected tools. Remote
                  administrative settings will appear when supported by the
                  device provider.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
      <footer className="preferences-footer">
        {resetOpen ? (
          <>
            <span>Restore all desktop preferences?</span>
            <button onClick={() => setResetOpen(false)}>Keep settings</button>
            <button
              className="restore-confirm"
              onClick={() => {
                reset();
                setResetOpen(false);
              }}
            >
              Restore defaults
            </button>
          </>
        ) : (
          <>
            <span role="status">
              {error
                ? "Preferences need attention"
                : "Changes apply immediately · Saved on this device"}
            </span>
            <button onClick={() => setResetOpen(true)}>
              <RotateCcw size={13} /> Restore defaults
            </button>
          </>
        )}
      </footer>
    </dialog>,
    document.body,
  );
}
