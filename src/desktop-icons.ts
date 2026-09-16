// SPDX-License-Identifier: MPL-2.0
/**
 * Desktop shortcuts: what sits on the desktop ground, and where.
 *
 * Positions are grid cells, not pixels. A pixel layout saved on a wide monitor
 * drops icons off the bottom of a laptop screen, and every resize would need a
 * rescue pass. A cell is resolved against whatever grid currently fits, so the
 * same arrangement stays reachable at any size.
 */
import { useSyncExternalStore } from "react";

export type ShortcutKind = "app" | "folder";

export interface DesktopShortcut {
  /** Stable within one desktop; never reused. */
  id: string;
  kind: ShortcutKind;
  /**
   * An app id, or a folder location. Provider paths are opaque tokens: stored
   * verbatim, never split, joined or normalised.
   */
  target: string;
  name: string;
  column: number;
  row: number;
}

export interface GridCell {
  column: number;
  row: number;
}

export interface GridMetrics {
  columns: number;
  rows: number;
}

/** Layout coordinates stay physical pixels; the rendered tile is sized in rem. */
export const cellWidth = 92;
export const cellHeight = 100;

/** One desktop holds plenty already; the cap stops a runaway writer. */
export const maxShortcuts = 256;

export const desktopIconsKey = "shellcanvas.desktop-icons";

/** The grid that fits a ground this size. Always at least one cell. */
export function gridFor(width: number, height: number): GridMetrics {
  return {
    columns: Math.max(1, Math.floor(width / cellWidth)),
    rows: Math.max(1, Math.floor(height / cellHeight)),
  };
}

/** Keep overflow in additional scrollable columns rather than losing shortcuts. */
export function gridForIcons(grid: GridMetrics, count: number): GridMetrics {
  return {
    ...grid,
    columns: Math.max(grid.columns, Math.ceil(count / grid.rows)),
  };
}

const at = (cell: GridCell) => cell.column + "," + cell.row;

export function clampCell(cell: GridCell, grid: GridMetrics): GridCell {
  return {
    column: Math.max(0, Math.min(grid.columns - 1, Math.round(cell.column))),
    row: Math.max(0, Math.min(grid.rows - 1, Math.round(cell.row))),
  };
}

/** The cell under a point measured from the grid top-left corner. */
export function cellAt(x: number, y: number, grid: GridMetrics): GridCell {
  return clampCell(
    { column: Math.floor(x / cellWidth), row: Math.floor(y / cellHeight) },
    grid,
  );
}

export function cellOrigin(cell: GridCell): { left: number; top: number } {
  return { left: cell.column * cellWidth, top: cell.row * cellHeight };
}

/**
 * The first unused cell, filling down each column before moving right, which is
 * the order desktops have always used. Searching from a cell lets a dropped
 * icon land beside where it was released instead of jumping to the corner.
 */
export function freeCell(
  taken: readonly DesktopShortcut[],
  grid: GridMetrics,
  from?: GridCell,
): GridCell | null {
  const used = new Set(taken.map(at));
  const total = grid.columns * grid.rows;
  const origin = from ? clampCell(from, grid) : { column: 0, row: 0 };
  const start = origin.column * grid.rows + origin.row;
  for (let offset = 0; offset < total; offset++) {
    const index = (start + offset) % total;
    const cell = {
      column: Math.floor(index / grid.rows),
      row: index % grid.rows,
    };
    if (!used.has(at(cell))) return cell;
  }
  return null;
}

/** Move one shortcut. An occupied cell pushes it to the nearest free one. */
export function place(
  icons: readonly DesktopShortcut[],
  id: string,
  cell: GridCell,
  grid: GridMetrics,
): DesktopShortcut[] {
  const target = clampCell(cell, grid);
  const others = icons.filter((icon) => icon.id !== id);
  const spot = others.some((icon) => at(icon) === at(target))
    ? freeCell(others, grid, target)
    : target;
  if (!spot) return [...icons];
  return icons.map((icon) => (icon.id === id ? { ...icon, ...spot } : icon));
}

/** Re-tile everything into fill order, keeping the current reading order. */
export function arrange(
  icons: readonly DesktopShortcut[],
  grid: GridMetrics,
): DesktopShortcut[] {
  grid = gridForIcons(grid, icons.length);
  const ordered = [...icons].sort(
    (a, b) => a.column - b.column || a.row - b.row,
  );
  return ordered.map((icon, index) => ({
    ...icon,
    column: Math.floor(index / grid.rows) % Math.max(1, grid.columns),
    row: index % grid.rows,
  }));
}

/**
 * Pull shortcuts back inside a grid that shrank, and separate any sharing a
 * cell. Icons already in a legal, unique cell do not move: a narrower window
 * must not rearrange a desktop somebody set up deliberately.
 */
export function reflow(
  icons: readonly DesktopShortcut[],
  grid: GridMetrics,
): DesktopShortcut[] {
  grid = gridForIcons(grid, icons.length);
  const settled: DesktopShortcut[] = [];
  const displaced: DesktopShortcut[] = [];
  for (const icon of icons) {
    const inside =
      icon.column >= 0 &&
      icon.row >= 0 &&
      icon.column < grid.columns &&
      icon.row < grid.rows;
    if (inside && !settled.some((other) => at(other) === at(icon)))
      settled.push(icon);
    else displaced.push(icon);
  }
  if (!displaced.length) return [...icons];
  for (const icon of displaced) {
    const spot = freeCell(settled, grid);
    if (spot) settled.push({ ...icon, ...spot });
  }
  return settled;
}

export function shortcutId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  const stamp = Date.now().toString(36);
  return "icon-" + stamp + "-" + Math.random().toString(36).slice(2, 8);
}

/** Add a shortcut unless that exact target already sits on this desktop. */
export function addShortcut(
  icons: readonly DesktopShortcut[],
  shortcut: Omit<DesktopShortcut, "id" | "column" | "row">,
  grid: GridMetrics,
  id: string = shortcutId(),
): DesktopShortcut[] {
  const duplicate = icons.some(
    (icon) => icon.kind === shortcut.kind && icon.target === shortcut.target,
  );
  if (duplicate || icons.length >= maxShortcuts) return [...icons];
  const spot = freeCell(icons, grid);
  if (!spot) return [...icons];
  return [...icons, { ...shortcut, id, ...spot }];
}

export type PinShortcutResult = "added" | "duplicate" | "full" | "unavailable";

/** Apply the Add to desktop command to one resolved desktop identity. */
export function pinDesktopShortcut(
  desktop: string | null,
  blocked: boolean,
  icons: readonly DesktopShortcut[],
  shortcut: Omit<DesktopShortcut, "id" | "column" | "row">,
  grid: GridMetrics,
  save: (desktop: string, icons: readonly DesktopShortcut[]) => void,
): PinShortcutResult {
  if (!desktop || blocked) return "unavailable";
  if (
    icons.some(
      (icon) => icon.kind === shortcut.kind && icon.target === shortcut.target,
    )
  )
    return "duplicate";
  const next = addShortcut(icons, shortcut, grid);
  if (next.length === icons.length) return "full";
  save(desktop, next);
  return "added";
}

export function removeShortcut(
  icons: readonly DesktopShortcut[],
  id: string,
): DesktopShortcut[] {
  return icons.filter((icon) => icon.id !== id);
}

type StorageAccess = Pick<Storage, "getItem" | "setItem">;

export interface DesktopIconsSnapshot {
  /** Keyed by workspace identity, so one host desktop is never another. */
  desktops: Readonly<Record<string, DesktopShortcut[]>>;
  error: string;
  blocked: boolean;
}

const empty: DesktopShortcut[] = [];

function validShortcut(value: unknown): value is DesktopShortcut {
  const icon = value as DesktopShortcut;
  return (
    !!icon &&
    typeof icon === "object" &&
    typeof icon.id === "string" &&
    !!icon.id &&
    (icon.kind === "app" || icon.kind === "folder") &&
    typeof icon.target === "string" &&
    !!icon.target &&
    typeof icon.name === "string" &&
    Number.isInteger(icon.column) &&
    Number.isInteger(icon.row) &&
    icon.column >= 0 &&
    icon.row >= 0
  );
}

/**
 * Saved desktop layouts. A corrupt or future store is reported and left in
 * place rather than replaced: losing a deliberate arrangement without saying so
 * is worse than reporting that the layout could not be read.
 */
export function createDesktopIconsStore(
  storage: () => StorageAccess,
  key: string = desktopIconsKey,
) {
  const listeners = new Set<() => void>();
  function read(): DesktopIconsSnapshot {
    try {
      const raw = storage().getItem(key);
      if (!raw) return { desktops: {}, error: "", blocked: false };
      const stored = JSON.parse(raw);
      if (
        stored?.version !== 1 ||
        !stored.desktops ||
        typeof stored.desktops !== "object" ||
        Array.isArray(stored.desktops)
      )
        throw new Error("Unknown desktop icon format");
      const desktops: Record<string, DesktopShortcut[]> = {};
      for (const [id, icons] of Object.entries(stored.desktops)) {
        if (!Array.isArray(icons) || !icons.every(validShortcut))
          throw new Error("Unknown desktop icon format");
        desktops[id] = (icons as DesktopShortcut[]).slice(0, maxShortcuts);
      }
      return { desktops, error: "", blocked: false };
    } catch {
      return {
        desktops: {},
        blocked: true,
        error:
          "Saved desktop icons could not be read. The saved layout has been preserved; shortcuts cannot be changed until it is recovered.",
      };
    }
  }
  let snapshot = read();
  const notify = () => listeners.forEach((listener) => listener());
  function write(desktops: Record<string, DesktopShortcut[]>) {
    try {
      storage().setItem(key, JSON.stringify({ version: 1, desktops }));
      snapshot = { desktops, error: "", blocked: false };
    } catch {
      snapshot = {
        desktops,
        blocked: false,
        error:
          "These icons apply for now, but could not be saved on this device. Try again or check available storage.",
      };
    }
    notify();
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    icons: (desktop: string | null) =>
      (desktop && snapshot.desktops[desktop]) || empty,
    set(desktop: string, icons: readonly DesktopShortcut[]) {
      if (snapshot.blocked) return;
      write({ ...snapshot.desktops, [desktop]: icons.slice(0, maxShortcuts) });
    },
    reload() {
      snapshot = read();
      notify();
    },
  };
}

export type DesktopIconsStore = ReturnType<typeof createDesktopIconsStore>;

/** Preview runs a synthetic host; its layout must never reach a real desktop. */
export function desktopIconsStorageKey(native: boolean) {
  return native ? desktopIconsKey : desktopIconsKey + ".preview";
}

// Keyed, because the preview and native stores must not share one instance.
const stores = new Map<string, DesktopIconsStore>();
function getStore(key: string) {
  const existing = stores.get(key);
  if (existing) return existing;
  const created = createDesktopIconsStore(() => window.localStorage, key);
  stores.set(key, created);
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) stores.get(key)?.reload();
  });
  return created;
}

export function useDesktopIcons(desktop: string | null, native = true) {
  const current = getStore(desktopIconsStorageKey(native));
  const snapshot = useSyncExternalStore(
    current.subscribe,
    current.getSnapshot,
    current.getSnapshot,
  );
  return {
    icons: (desktop && snapshot.desktops[desktop]) || empty,
    error: snapshot.error,
    blocked: snapshot.blocked,
    set: current.set,
  };
}
