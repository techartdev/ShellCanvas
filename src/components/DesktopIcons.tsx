// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from "react";
import { Folder } from "lucide-react";
import { AppIcon } from "./AppIcon";
import {
  cellAt,
  cellHeight,
  cellOrigin,
  cellWidth,
  gridFor,
  gridForIcons,
  type DesktopShortcut,
  type GridCell,
  type GridMetrics,
} from "../desktop-icons";
import type { DesktopApp } from "../sdk";
import "./DesktopIcons.css";

/** Matches every other move affordance on the desktop. */
const dragWidth = 900;
/** A press that never travels this far stays a click, not a drag. */
const dragThreshold = 4;

interface Drag {
  id: string;
  pointerId: number;
  /** Where in the tile the pointer grabbed it. */
  offsetX: number;
  offsetY: number;
  left: number;
  top: number;
  moved: boolean;
}

export function DesktopIcons({
  icons,
  apps,
  unavailable,
  open,
  move,
  menu,
  report,
}: {
  icons: readonly DesktopShortcut[];
  apps: readonly DesktopApp[];
  /** Why this shortcut cannot open right now, or "" when it can. */
  unavailable?: (icon: DesktopShortcut) => string;
  open: (icon: DesktopShortcut) => void;
  move: (id: string, cell: GridCell, grid: GridMetrics) => void;
  menu: (icon: DesktopShortcut, x: number, y: number) => void;
  /** The grid this ground currently fits, for placing and arranging. */
  report?: (grid: GridMetrics) => void;
}) {
  const ground = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState<Drag | null>(null);
  const [grid, setGrid] = useState<GridMetrics>({ columns: 1, rows: 1 });

  useEffect(() => {
    const element = ground.current;
    if (!element) return;
    const measure = () => {
      const next = gridForIcons(
        gridFor(element.clientWidth, element.clientHeight),
        icons.length,
      );
      setGrid(next);
      report?.(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [report, icons.length]);

  // A drag interrupted by anything at all ends where it started.
  useEffect(() => {
    const cancel = () => {
      drag.current = null;
      setDragging(null);
    };
    window.addEventListener("blur", cancel);
    return () => window.removeEventListener("blur", cancel);
  }, []);

  function finish(icon: DesktopShortcut) {
    const current = drag.current;
    drag.current = null;
    setDragging(null);
    if (!current?.moved) return;
    // The cell under the tile's own centre, not under the pointer, so an icon
    // grabbed by its label does not land a row lower than it looks.
    move(
      icon.id,
      cellAt(current.left + cellWidth / 2, current.top + cellHeight / 2, grid),
      grid,
    );
  }

  return (
    <div
      className="desktop-icons"
      ref={ground}
      style={
        {
          "--icon-cell-width": `${cellWidth}px`,
          "--icon-cell-height": `${cellHeight}px`,
        } as React.CSSProperties
      }
    >
      {icons.map((icon) => {
        const app =
          icon.kind === "app"
            ? apps.find((item) => item.id === icon.target)
            : undefined;
        const reason = unavailable?.(icon) ?? "";
        const held = dragging?.id === icon.id ? dragging : null;
        const origin = cellOrigin(icon);
        const kind = icon.kind === "app" ? "app shortcut" : "folder shortcut";
        return (
          <button
            key={icon.id}
            type="button"
            className={`desktop-icon${held ? " dragging" : ""}${reason ? " unavailable" : ""}`}
            style={{
              left: held ? held.left : origin.left,
              top: held ? held.top : origin.top,
            }}
            aria-label={`${icon.name}, ${kind}`}
            aria-disabled={reason ? true : undefined}
            title={reason || (icon.kind === "folder" ? icon.target : icon.name)}
            onDoubleClick={() => {
              if (!reason) open(icon);
            }}
            onContextMenu={(event) => {
              // The desktop menu lives on <main>; an icon answers for itself.
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.focus({ preventScroll: true });
              menu(icon, event.clientX, event.clientY);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (!reason) open(icon);
                return;
              }
              if (
                event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10")
              ) {
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                menu(icon, bounds.left, bounds.top);
                return;
              }
              const step = {
                ArrowLeft: { column: -1, row: 0 },
                ArrowRight: { column: 1, row: 0 },
                ArrowUp: { column: 0, row: -1 },
                ArrowDown: { column: 0, row: 1 },
              }[event.key];
              // Arranging without a pointer, matching the window move mode.
              if (!step || !(event.ctrlKey || event.metaKey)) return;
              event.preventDefault();
              move(
                icon.id,
                { column: icon.column + step.column, row: icon.row + step.row },
                grid,
              );
            }}
            onPointerDown={(event) => {
              if (
                event.button !== 0 ||
                !event.isPrimary ||
                window.innerWidth < dragWidth
              )
                return;
              const bounds = event.currentTarget.getBoundingClientRect();
              drag.current = {
                id: icon.id,
                pointerId: event.pointerId,
                offsetX: event.clientX - bounds.left,
                offsetY: event.clientY - bounds.top,
                left: origin.left,
                top: origin.top,
                moved: false,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const current = drag.current;
              if (!current || current.pointerId !== event.pointerId) return;
              const area = ground.current;
              if (!area) return;
              const bounds = area.getBoundingClientRect();
              const left =
                event.clientX - bounds.left - current.offsetX + area.scrollLeft;
              const top = event.clientY - bounds.top - current.offsetY;
              if (
                !current.moved &&
                Math.abs(left - current.left) < dragThreshold &&
                Math.abs(top - current.top) < dragThreshold
              )
                return;
              current.moved = true;
              current.left = Math.max(
                0,
                Math.min(grid.columns * cellWidth - cellWidth, left),
              );
              current.top = Math.max(
                0,
                Math.min(area.clientHeight - cellHeight, top),
              );
              setDragging({ ...current });
            }}
            onPointerUp={() => finish(icon)}
            onPointerCancel={() => {
              drag.current = null;
              setDragging(null);
            }}
            onLostPointerCapture={() => {
              drag.current = null;
              setDragging(null);
            }}
          >
            <span className="desktop-icon-art">
              {icon.kind === "folder" ? (
                <span
                  className="dock-app-icon app-icon desktop-folder-icon"
                  data-size="tile"
                  aria-hidden="true"
                >
                  <Folder />
                </span>
              ) : (
                <AppIcon
                  id={icon.target}
                  image={app?.image}
                  icon={app?.icon}
                  size="tile"
                />
              )}
            </span>
            <span className="desktop-icon-label">{icon.name}</span>
          </button>
        );
      })}
    </div>
  );
}
