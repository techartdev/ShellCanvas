// SPDX-License-Identifier: MPL-2.0
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuAction {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  separatorBefore?: boolean;
  run(): void;
}
export function ContextMenu({
  x,
  y,
  actions,
  close,
  label = "Actions",
}: {
  x: number;
  y: number;
  actions: MenuAction[];
  close(): void;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });
  useLayoutEffect(() => {
    const menu = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    setPosition({
      x: Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)),
      y: Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)),
    });
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node)) close();
    };
    const dismiss = () => close();
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      previous?.isConnected && previous.focus({ preventScroll: true });
    };
  }, [x, y, close]);
  return createPortal(
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={label}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          close();
          return;
        }
        const buttons = Array.from(
          ref.current!.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        );
        const current = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? buttons.length - 1
              : e.key === "ArrowDown"
                ? (current + 1) % buttons.length
                : e.key === "ArrowUp"
                  ? (current + buttons.length - 1) % buttons.length
                  : -1;
        if (next >= 0) {
          e.preventDefault();
          buttons[next]?.focus();
        }
      }}
    >
      {actions.map((action) => (
        <button
          role="menuitem"
          key={action.id}
          disabled={action.disabled}
          className={action.separatorBefore ? "menu-group-start" : undefined}
          onClick={() => {
            close();
            action.run();
          }}
        >
          <span>{action.label}</span>
          <kbd>{action.shortcut}</kbd>
        </button>
      ))}
    </div>,
    document.body,
  );
}
