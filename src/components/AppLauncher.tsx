// SPDX-License-Identifier: MPL-2.0
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Plus, Search } from "lucide-react";
import type { DesktopApp } from "../sdk";
import { matchesSearch } from "../extensions/app-listing";
import { AppIcon } from "./AppIcon";
import "./AppLauncher.css";

/** Full-desktop launcher for apps that can open now. Managing apps is separate. */
export function AppLauncher({
  apps,
  running,
  blocked,
  launch,
  close,
  connect,
}: {
  apps: readonly DesktopApp[];
  running(id: string): boolean;
  /** Why an app cannot open right now; undefined when it can. */
  blocked(app: DesktopApp): string | undefined;
  launch(id: string): void;
  close(): void;
  connect(): void;
}) {
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const dismiss = useRef(close);
  dismiss.current = close;
  const grid = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const launched = useRef(false);
  const visible = useMemo(
    () =>
      apps.filter((app) =>
        matchesSearch(query, [app.title, app.description, app.subtitle]),
      ),
    [apps, query],
  );
  useEffect(() => {
    // Dismissal returns focus to the dock or brand button; a launch leaves it
    // for the app window.
    const opener = document.activeElement as HTMLElement | null;
    search.current?.focus();
    return () => {
      if (!launched.current && opener?.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => {
    // Modal like the desktop dialogs: Tab stays inside. The dock stays
    // clickable to toggle the launcher, so focus there is brought back and
    // Escape still closes.
    function keys(event: globalThis.KeyboardEvent) {
      const root = dialog.current;
      if (!root || event.defaultPrevented) return;
      const inside = root.contains(document.activeElement);
      if (event.key === "Escape" && !inside) {
        event.preventDefault();
        dismiss.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [...root.querySelectorAll<HTMLElement>("input, button")];
      const first = controls[0];
      const last = controls.at(-1);
      if (!inside) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  }, []);
  const items = () => [
    ...(grid.current?.querySelectorAll<HTMLButtonElement>("button") ?? []),
  ];
  const open = (app: DesktopApp) => {
    if (blocked(app)) return;
    launched.current = true;
    launch(app.id);
  };
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    // Columns follow the responsive layout: count items sharing the first row.
    const columns = Math.max(
      1,
      list.filter((item) => item.offsetTop === list[0].offsetTop).length,
    );
    const step = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -columns,
      ArrowDown: columns,
    }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    if (event.key === "ArrowUp" && index < columns) {
      search.current?.focus();
      return;
    }
    list[Math.min(list.length - 1, Math.max(0, index + step))]?.focus();
  };
  return (
    <div
      ref={dialog}
      className="app-launcher"
      role="dialog"
      aria-modal="true"
      aria-label="App launcher"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <div className="app-launcher-search">
        <Search size={16} />
        <input
          ref={search}
          value={query}
          placeholder="Search apps"
          aria-label="Search apps"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              items()[0]?.focus();
            } else if (event.key === "Enter") {
              const first = visible.find((app) => !blocked(app));
              if (first) {
                event.preventDefault();
                open(first);
              }
            }
          }}
        />
      </div>
      <div
        ref={grid}
        className="app-launcher-grid"
        aria-label="Apps"
        onKeyDown={move}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        {visible.map((app) => {
          const reason = blocked(app);
          const active = !reason && running(app.id);
          return (
            <button
              key={app.id}
              className="app-launcher-item"
              aria-disabled={reason ? true : undefined}
              aria-label={`${app.title}${active ? ", running" : ""}${reason ? `, unavailable: ${reason}` : ""}`}
              title={reason ?? app.description ?? app.subtitle}
              onClick={() => open(app)}
            >
              <AppIcon
                id={app.id}
                image={app.image}
                icon={app.icon}
                size="launcher"
              />
              <span className="app-launcher-name">{app.title}</span>
              {reason ? (
                <small className="app-launcher-note">{reason}</small>
              ) : (
                active && <span className="app-launcher-running" />
              )}
            </button>
          );
        })}
      </div>
      {!visible.length && (
        <p className="app-launcher-empty" role="status">
          No apps match “{query.trim()}”.
        </p>
      )}
      <div className="app-launcher-footer">
        <button
          onClick={() => {
            close();
            connect();
          }}
        >
          <Plus size={15} />
          Connect another host
        </button>
      </div>
    </div>
  );
}
