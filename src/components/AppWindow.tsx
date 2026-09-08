// SPDX-License-Identifier: MPL-2.0
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Maximize2,
  Minimize2,
  Minus,
  MoreHorizontal,
  Plus,
  X,
} from "lucide-react";
import type { AppContext, DesktopApp } from "../sdk";
import { unavailableReason, capabilityReason } from "../sdk";
import { SystemScope } from "../system-dialogs";
import { scopeAppServices } from "../app-services";
import { AppBoundary } from "./AppBoundary";
import { ContextMenu } from "./ContextMenu";
import { ConfirmDialog } from "./ConfirmDialog";
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
  dirty = false,
  busy = false,
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
  dirty?: boolean;
  busy?: boolean;
}) {
  const appServices = useMemo(
    () => scopeAppServices(context.services, app),
    [context.services, app],
  );
  const systemState = useRef({ context, focus });
  systemState.current = { context, focus };
  const systemScope = useMemo(
    () =>
      new SystemScope(
        app.title,
        appServices,
        (capability) => {
          const current = systemState.current.context;
          return (
            app.scope === "host" &&
            [...app.requires, ...(app.optional ?? [])].includes(capability) &&
            current.connected !== false &&
            !!current.session &&
            !capabilityReason(current.session, capability)
          );
        },
        () => systemState.current.focus(),
      ),
    [app, appServices],
  );
  useLayoutEffect(() => {
    systemScope.activate();
    return () => systemScope.dispose();
  }, [systemScope]);
  useLayoutEffect(() => {
    systemScope.setVisible(visible);
    if (context.connected === false) systemScope.suspend();
  }, [systemScope, visible, context.connected]);
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [desktopLayout, setDesktopLayout] = useState(
    () => window.innerWidth >= 900,
  );
  const [tiled, setTiled] = useState<"left" | "right" | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [adjustment, setAdjustment] = useState<{
    mode: "move" | "resize";
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const titlebar = useRef<HTMLElement>(null);
  const arranged = maximized || !!tiled;
  const restoreOrMaximize = () => {
    setMaximized(!arranged);
    setTiled(null);
    setAdjustment(null);
  };
  const beginAdjustment = (mode: "move" | "resize") => {
    const el = element.current;
    if (!el || arranged || window.innerWidth < 900) return;
    const rect = el.getBoundingClientRect();
    const bounds = el.parentElement!.getBoundingClientRect();
    // Freeze the rendered rectangle, including windows initially anchored at the right.
    setPosition({ left: rect.left - bounds.left, top: rect.top - bounds.top });
    setSize({ width: rect.width, height: rect.height });
    setAdjustment({
      mode,
      left: rect.left - bounds.left,
      top: rect.top - bounds.top,
      width: rect.width,
      height: rect.height,
    });
  };
  useLayoutEffect(() => {
    if (adjustment) titlebar.current?.focus({ preventScroll: true });
  }, [adjustment]);
  useEffect(() => {
    if (!visible) setAdjustment(null);
  }, [visible]);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 900px)");
    const changed = () => {
      setDesktopLayout(query.matches);
      if (!query.matches) setAdjustment(null);
    };
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmClose(true);
    else close();
  };
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
  const [opened, setOpened] = useState(!reason);
  useEffect(() => {
    if (!reason) setOpened(true);
  }, [reason]);
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
      if (window.innerWidth < 900 || !element.current || arranged || !visible)
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
  }, [arranged, visible]);
  const Component = app.component;
  const Icon = app.icon;
  return (
    <section
      ref={element}
      style={
        {
          zIndex: order + 1,
          ...(size ?? {}),
          ...(position && !arranged
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
      className={`app-window window-${app.window?.layout ?? "standard"} ${focused ? "focused" : ""} ${maximized ? "maximized" : ""} ${tiled ? `tiled tiled-${tiled}` : ""} ${!visible ? "hidden-window" : ""}`}
      onPointerDownCapture={focus}
      onFocusCapture={focus}
      aria-label={`${title} window`}
    >
      <header
        ref={titlebar}
        tabIndex={0}
        data-window-titlebar
        aria-label={`${title} window controls`}
        title="Window actions: Shift+F10 · Next window: F6"
        className="window-titlebar"
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (adjustment && event.target === event.currentTarget) {
            if (event.key === "Escape" || event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Escape") {
                const parent = element.current!.parentElement!;
                setPosition({
                  left: Math.max(
                    0,
                    Math.min(
                      adjustment.left,
                      parent.clientWidth - adjustment.width,
                    ),
                  ),
                  top: Math.max(
                    0,
                    Math.min(
                      adjustment.top,
                      parent.clientHeight - adjustment.height,
                    ),
                  ),
                });
                setSize({ width: adjustment.width, height: adjustment.height });
              }
              setAdjustment(null);
              return;
            }
            if (
              event.key.startsWith("Arrow") &&
              element.current &&
              window.innerWidth >= 900
            ) {
              event.preventDefault();
              event.stopPropagation();
              const el = element.current;
              const parent = el.parentElement!;
              const rect = el.getBoundingClientRect();
              const bounds = parent.getBoundingClientRect();
              const left = rect.left - bounds.left;
              const top = rect.top - bounds.top;
              const step = event.shiftKey ? 1 : 16;
              const dx =
                event.key === "ArrowRight"
                  ? step
                  : event.key === "ArrowLeft"
                    ? -step
                    : 0;
              const dy =
                event.key === "ArrowDown"
                  ? step
                  : event.key === "ArrowUp"
                    ? -step
                    : 0;
              if (adjustment.mode === "move") {
                setPosition({
                  left: Math.max(
                    0,
                    Math.min(parent.clientWidth - rect.width, left + dx),
                  ),
                  top: Math.max(
                    0,
                    Math.min(parent.clientHeight - rect.height, top + dy),
                  ),
                });
              } else {
                const style = getComputedStyle(el);
                setSize({
                  width: Math.min(
                    parent.clientWidth - left,
                    Math.max(parseFloat(style.minWidth), rect.width + dx),
                  ),
                  height: Math.min(
                    parent.clientHeight - top,
                    Math.max(parseFloat(style.minHeight), rect.height + dy),
                  ),
                });
              }
              return;
            }
          }
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
          if (desktopLayout && !(event.target as HTMLElement).closest("button"))
            restoreOrMaximize();
        }}
        onPointerDown={(e) => {
          if (
            arranged ||
            e.button !== 0 ||
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
          e.currentTarget.focus({ preventScroll: true });
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
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      >
        <span className="window-title">
          <Icon size={16} />
          <span className="window-name">{title}</span>
          {dirty && (
            <span
              className="unsaved-dot"
              title="Unsaved changes"
              aria-label="Unsaved changes"
            />
          )}
          {app.scope === "host" && context.session && (
            <small>{context.session.info.hostname}</small>
          )}
        </span>
        <div className="window-controls">
          <button
            title="Window actions"
            aria-label={`${title} window actions`}
            onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              setMenu({ x: bounds.right - 220, y: bounds.bottom });
            }}
          >
            <MoreHorizontal size={14} />
          </button>
          {app.window?.multiple && (
            <button
              title={`New ${app.title} window`}
              aria-label={`New ${app.title} window`}
              disabled={!!reason}
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
            title={arranged ? "Restore window" : "Maximize window"}
            aria-label={arranged ? "Restore window" : "Maximize window"}
            disabled={!desktopLayout}
            onClick={restoreOrMaximize}
          >
            {arranged ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button
            title={`Close ${title}`}
            aria-label={`Close ${title}`}
            onClick={requestClose}
            disabled={busy}
          >
            <X size={15} />
          </button>
        </div>
      </header>
      {adjustment && (
        <div className="window-adjustment" role="status">
          {adjustment.mode === "move" ? "Move" : "Resize"}: arrow keys · Shift
          for precision · Enter to finish · Esc to cancel
          <button onClick={() => setAdjustment(null)}>Done</button>
        </div>
      )}
      <div className="window-content">
        {reason && !opened ? (
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
          <AppBoundary title={app.title}>
            {reason && (
              <div className="inline-error" role="status">
                {reason}. Your open work is preserved.
              </div>
            )}
            <Component
              {...context}
              services={appServices}
              system={systemScope.api}
              visible={visible}
              connected={context.connected !== false && !reason}
              unavailableReason={reason ?? undefined}
            />
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
                    disabled: !!reason,
                    run: () => context.openApp?.(app.id),
                  },
                ]
              : []),
            { id: "minimize", label: "Minimize", run: minimize },
            {
              id: "maximize",
              label: arranged ? "Restore" : "Maximize",
              disabled: !desktopLayout,
              run: restoreOrMaximize,
            },
            {
              id: "move",
              label: "Move with keyboard",
              disabled: arranged || !desktopLayout,
              run: () => beginAdjustment("move"),
            },
            {
              id: "resize",
              label: "Resize with keyboard",
              disabled: arranged || !desktopLayout,
              run: () => beginAdjustment("resize"),
            },
            {
              id: "tile-left",
              label: "Tile left",
              disabled: !desktopLayout,
              run: () => {
                setMaximized(false);
                setTiled("left");
                setAdjustment(null);
              },
            },
            {
              id: "tile-right",
              label: "Tile right",
              disabled: !desktopLayout,
              run: () => {
                setMaximized(false);
                setTiled("right");
                setAdjustment(null);
              },
            },
            {
              id: "close",
              label: "Close window",
              separatorBefore: true,
              run: requestClose,
              disabled: busy,
            },
          ]}
        />
      )}
      {confirmClose && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message={`Your changes in ${title} have not been saved to the remote host.`}
          confirmLabel="Discard and close"
          disabled={busy}
          confirm={close}
          cancel={() => setConfirmClose(false)}
        />
      )}
    </section>
  );
}
