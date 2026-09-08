// SPDX-License-Identifier: MPL-2.0
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Maximize2, Minimize2, Minus, Plus, X } from "lucide-react";
import type { AppContext, DesktopApp } from "../sdk";
import { unavailableReason } from "../sdk";
import { AppBoundary } from "./AppBoundary";
import { ContextMenu } from "./ContextMenu";
export function AppWindow({
  app,
  context,
  focused,
  focus,
  visible,
  minimize,
  close,
  order,
  title = app.title,
  cascade = 0,
}: {
  app: DesktopApp;
  context: AppContext;
  focused: boolean;
  focus(): void;
  visible: boolean;
  minimize(): void;
  close(): void;
  order: number;
  title?: string;
  cascade?: number;
}) {
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useEffect(() => {
    if (!visible) closeMenu();
  }, [visible, closeMenu]);
  const element = useRef<HTMLElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const reason = unavailableReason(app, context.session);
  useEffect(() => {
    if (!cascade || !element.current || window.innerWidth < 900) return;
    const el = element.current;
    const parent = el.parentElement!;
    const rect = el.getBoundingClientRect();
    const bounds = parent.getBoundingClientRect();
    const offset = (cascade % 7) * 26;
    setPosition({
      left: Math.max(
        0,
        Math.min(
          rect.left - bounds.left + offset,
          parent.clientWidth - el.offsetWidth,
        ),
      ),
      top: Math.max(
        0,
        Math.min(
          rect.top - bounds.top + offset,
          parent.clientHeight - el.offsetHeight,
        ),
      ),
    });
  }, []);
  useEffect(() => {
    const parent = element.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(() => {
      if (window.innerWidth < 900 || !element.current || maximized || !visible)
        return;
      const width = element.current.offsetWidth;
      const height = element.current.offsetHeight;
      setPosition((previous) => {
        if (!previous) return previous;
        const left = Math.max(
          0,
          Math.min(previous.left, parent.clientWidth - width),
        );
        const top = Math.max(
          0,
          Math.min(previous.top, parent.clientHeight - height),
        );
        return left === previous.left && top === previous.top
          ? previous
          : { left, top };
      });
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [maximized, visible]);
  const Component = app.component;
  const Icon = app.icon;
  return (
    <section
      ref={element}
      style={
        {
          zIndex: order + 1,
          ...(position && !maximized
            ? {
                left: position.left,
                top: position.top,
                right: "auto",
                "--window-x": `${position.left}px`,
                "--window-y": `${position.top}px`,
              }
            : {}),
        } as CSSProperties
      }
      className={`app-window window-${app.window?.layout ?? "standard"} ${focused ? "focused" : ""} ${maximized ? "maximized" : ""} ${!visible ? "hidden-window" : ""}`}
      onPointerDownCapture={focus}
      onFocusCapture={focus}
      aria-label={`${title} window`}
    >
      <header
        className="window-titlebar"
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (
            event.key !== "ContextMenu" &&
            !(event.shiftKey && event.key === "F10")
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          setMenu({ x: bounds.right - 220, y: bounds.bottom });
        }}
        onDoubleClick={(event) => {
          if (!(event.target as HTMLElement).closest("button"))
            setMaximized(!maximized);
        }}
        onPointerDown={(e) => {
          if (
            maximized ||
            window.innerWidth < 900 ||
            (e.target as HTMLElement).closest("button")
          )
            return;
          const rect = element.current!.getBoundingClientRect();
          const parent =
            element.current!.parentElement!.getBoundingClientRect();
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            left: rect.left - parent.left,
            top: rect.top - parent.top,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current || !element.current) return;
          const parent = element.current.parentElement!;
          setPosition({
            left: Math.max(
              0,
              Math.min(
                parent.clientWidth - element.current.offsetWidth,
                drag.current.left + e.clientX - drag.current.x,
              ),
            ),
            top: Math.max(
              0,
              Math.min(
                parent.clientHeight - element.current.offsetHeight,
                drag.current.top + e.clientY - drag.current.y,
              ),
            ),
          });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <span className="window-title">
          <Icon size={16} />
          {title}
          {app.scope === "host" && context.session && (
            <small>{context.session.info.hostname}</small>
          )}
        </span>
        <div className="window-controls">
          {app.window?.multiple && (
            <button
              title={`New ${app.title} window`}
              aria-label={`New ${app.title} window`}
              onClick={() => context.openApp?.(app.id)}
            >
              <Plus size={14} />
            </button>
          )}
          <button
            title={`Minimize ${title}`}
            aria-label={`Minimize ${title}`}
            onClick={minimize}
          >
            <Minus size={14} />
          </button>
          <button
            title={maximized ? "Restore window" : "Maximize window"}
            aria-label={maximized ? "Restore window" : "Maximize window"}
            onClick={() => setMaximized(!maximized)}
          >
            {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button
            title={`Close ${title}`}
            aria-label={`Close ${title}`}
            onClick={close}
          >
            <X size={15} />
          </button>
        </div>
      </header>
      <div className="window-content">
        {reason ? (
          <div className="app-empty">
            <span className={`empty-icon ${app.id}`}>
              <Icon size={30} />
            </span>
            <h2>{app.subtitle}</h2>
            <p>{reason}</p>
            {!context.session && (
              <button className="primary-button" onClick={context.connect}>
                Connect a host <span>↗</span>
              </button>
            )}
          </div>
        ) : (
          <AppBoundary
            key={
              app.scope === "host"
                ? (context.session?.id ?? "disconnected")
                : "local"
            }
            title={app.title}
          >
            <Component {...context} />
          </AppBoundary>
        )}
      </div>
      {menu && (
        <ContextMenu
          {...menu}
          label="Window actions"
          close={closeMenu}
          actions={[
            ...(app.window?.multiple
              ? [
                  {
                    id: "new",
                    label: `New ${app.title} window`,
                    run: () => context.openApp?.(app.id),
                  },
                ]
              : []),
            { id: "minimize", label: "Minimize", run: minimize },
            {
              id: "maximize",
              label: maximized ? "Restore" : "Maximize",
              run: () => setMaximized(!maximized),
            },
            {
              id: "close",
              label: "Close window",
              separatorBefore: true,
              run: close,
            },
          ]}
        />
      )}
    </section>
  );
}
