import { describe, expect, it } from "vitest";
import {
  addShortcut,
  arrange,
  cellAt,
  cellOrigin,
  createDesktopIconsStore,
  desktopIconsStorageKey,
  freeCell,
  gridFor,
  place,
  reflow,
  removeShortcut,
  type DesktopShortcut,
} from "./desktop-icons";

const icon = (
  id: string,
  column: number,
  row: number,
  rest: Partial<DesktopShortcut> = {},
): DesktopShortcut => ({
  id,
  kind: "app",
  target: id,
  name: id,
  column,
  row,
  ...rest,
});

function storage(initial?: Record<string, string>) {
  const entries = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    entries,
    access: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
    },
  };
}

describe("the icon grid", () => {
  it("fits whole cells and never reports an empty grid", () => {
    expect(gridFor(1000, 600)).toEqual({ columns: 10, rows: 6 });
    // A sliver of a desktop still has somewhere to put one icon.
    expect(gridFor(10, 10)).toEqual({ columns: 1, rows: 1 });
  });

  it("resolves a point to a cell and clamps to the grid", () => {
    const grid = gridFor(1000, 600);
    expect(cellAt(0, 0, grid)).toEqual({ column: 0, row: 0 });
    expect(cellAt(200, 250, grid)).toEqual({ column: 2, row: 2 });
    // Released past the edge, the icon stays on the desktop.
    expect(cellAt(99999, 99999, grid)).toEqual({ column: 9, row: 5 });
    expect(cellAt(-40, -40, grid)).toEqual({ column: 0, row: 0 });
    expect(cellOrigin({ column: 2, row: 3 })).toEqual({ left: 184, top: 300 });
  });

  it("fills down a column before starting the next one", () => {
    const grid = { columns: 3, rows: 2 };
    expect(freeCell([], grid)).toEqual({ column: 0, row: 0 });
    expect(freeCell([icon("a", 0, 0)], grid)).toEqual({ column: 0, row: 1 });
    expect(freeCell([icon("a", 0, 0), icon("b", 0, 1)], grid)).toEqual({
      column: 1,
      row: 0,
    });
  });

  it("searches from where the icon was dropped, not from the corner", () => {
    const grid = { columns: 3, rows: 2 };
    const taken = [icon("a", 2, 0)];
    expect(freeCell(taken, grid, { column: 2, row: 0 })).toEqual({
      column: 2,
      row: 1,
    });
  });

  it("reports no cell when the grid is full", () => {
    const grid = { columns: 1, rows: 1 };
    expect(freeCell([icon("a", 0, 0)], grid)).toBeNull();
  });
});

describe("moving an icon", () => {
  const grid = { columns: 3, rows: 2 };

  it("drops it into an empty cell", () => {
    const icons = [icon("a", 0, 0)];
    expect(place(icons, "a", { column: 2, row: 1 }, grid)).toEqual([
      icon("a", 2, 1),
    ]);
  });

  it("pushes it to the nearest free cell rather than stacking two icons", () => {
    const icons = [icon("a", 0, 0), icon("b", 1, 0)];
    const moved = place(icons, "b", { column: 0, row: 0 }, grid);
    expect(moved).toContainEqual(icon("a", 0, 0));
    expect(moved).toContainEqual(icon("b", 0, 1));
  });

  it("leaves the layout alone when the desktop is full", () => {
    const full = { columns: 1, rows: 2 };
    const icons = [icon("a", 0, 0), icon("b", 0, 1)];
    expect(place(icons, "b", { column: 0, row: 0 }, full)).toEqual(icons);
  });
});

describe("arranging and reflowing", () => {
  it("re-tiles in reading order", () => {
    const grid = { columns: 2, rows: 2 };
    const scattered = [icon("b", 1, 1), icon("a", 0, 1), icon("c", 1, 0)];
    expect(arrange(scattered, grid)).toEqual([
      icon("a", 0, 0),
      icon("c", 0, 1),
      icon("b", 1, 0),
    ]);
  });

  it("rescues icons a narrower desktop pushed out of bounds", () => {
    const icons = [icon("a", 0, 0), icon("b", 4, 0)];
    const narrow = reflow(icons, { columns: 1, rows: 2 });
    expect(narrow).toEqual([icon("a", 0, 0), icon("b", 0, 1)]);
  });

  it("keeps a deliberate arrangement untouched when everything still fits", () => {
    const icons = [icon("a", 0, 0), icon("b", 2, 1)];
    expect(reflow(icons, { columns: 3, rows: 2 })).toEqual(icons);
  });

  it("separates icons that ended up sharing a cell", () => {
    const icons = [icon("a", 0, 0), icon("b", 0, 0)];
    const fixed = reflow(icons, { columns: 2, rows: 2 });
    expect(fixed).toEqual([icon("a", 0, 0), icon("b", 0, 1)]);
  });
});

describe("adding and removing shortcuts", () => {
  const grid = { columns: 3, rows: 3 };

  it("places a new shortcut in the first free cell", () => {
    const added = addShortcut(
      [],
      { kind: "folder", target: "/srv/deploy", name: "deploy" },
      grid,
      "one",
    );
    expect(added).toEqual([
      {
        id: "one",
        kind: "folder",
        target: "/srv/deploy",
        name: "deploy",
        column: 0,
        row: 0,
      },
    ]);
  });

  it("refuses a duplicate target but allows the same name elsewhere", () => {
    const first = addShortcut(
      [],
      { kind: "folder", target: "/srv/deploy", name: "deploy" },
      grid,
      "one",
    );
    const again = addShortcut(
      first,
      { kind: "folder", target: "/srv/deploy", name: "deploy" },
      grid,
      "two",
    );
    expect(again).toHaveLength(1);
    const other = addShortcut(
      first,
      { kind: "folder", target: "/var/deploy", name: "deploy" },
      grid,
      "three",
    );
    expect(other).toHaveLength(2);
  });

  it("keeps an app and a folder with the same target apart", () => {
    const app = addShortcut(
      [],
      { kind: "app", target: "files", name: "Files" },
      grid,
      "one",
    );
    const folder = addShortcut(
      app,
      { kind: "folder", target: "files", name: "files" },
      grid,
      "two",
    );
    expect(folder).toHaveLength(2);
  });

  it("removes by identity", () => {
    const icons = [icon("a", 0, 0), icon("b", 0, 1)];
    expect(removeShortcut(icons, "a")).toEqual([icon("b", 0, 1)]);
    expect(removeShortcut(icons, "missing")).toEqual(icons);
  });
});

describe("the saved layout", () => {
  it("keeps each host desktop apart and survives a reload", () => {
    const target = storage();
    const store = createDesktopIconsStore(() => target.access);
    store.set("workspace-v1-aaa", [icon("a", 0, 0)]);
    store.set("workspace-v1-bbb", [icon("b", 1, 1)]);

    expect(store.icons("workspace-v1-aaa")).toEqual([icon("a", 0, 0)]);
    expect(store.icons("workspace-v1-bbb")).toEqual([icon("b", 1, 1)]);
    expect(store.icons("workspace-v1-unknown")).toEqual([]);
    expect(store.icons(null)).toEqual([]);

    // A second session reads what the first one wrote.
    const next = createDesktopIconsStore(() => target.access);
    expect(next.icons("workspace-v1-aaa")).toEqual([icon("a", 0, 0)]);
    expect(next.getSnapshot().blocked).toBe(false);
  });

  it("reports corrupt saved icons instead of silently discarding them", () => {
    const corrupt = storage({ "shellcanvas.desktop-icons": "{not json" });
    const store = createDesktopIconsStore(() => corrupt.access);
    expect(store.getSnapshot().blocked).toBe(true);
    expect(store.getSnapshot().error).toContain("could not be read");
    expect(store.icons("workspace-v1-aaa")).toEqual([]);
    // The unreadable payload is still on disk for recovery.
    expect(corrupt.entries.get("shellcanvas.desktop-icons")).toBe("{not json");
  });

  it("refuses a future version and a malformed shortcut", () => {
    const future = createDesktopIconsStore(
      () =>
        storage({
          "shellcanvas.desktop-icons": JSON.stringify({
            version: 2,
            desktops: {},
          }),
        }).access,
    );
    expect(future.getSnapshot().blocked).toBe(true);

    const bad = createDesktopIconsStore(
      () =>
        storage({
          "shellcanvas.desktop-icons": JSON.stringify({
            version: 1,
            desktops: {
              host: [
                {
                  id: "a",
                  kind: "app",
                  target: "files",
                  name: "Files",
                  column: -1,
                  row: 0,
                },
              ],
            },
          }),
        }).access,
    );
    expect(bad.getSnapshot().blocked).toBe(true);
  });

  it("keeps working when the device refuses the write", () => {
    const store = createDesktopIconsStore(() => ({
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    }));
    store.set("workspace-v1-aaa", [icon("a", 0, 0)]);
    const snapshot = store.getSnapshot();
    expect(snapshot.blocked).toBe(false);
    expect(snapshot.error).toContain("could not be saved");
    // The arrangement still applies for this session.
    expect(store.icons("workspace-v1-aaa")).toEqual([icon("a", 0, 0)]);
  });

  it("notifies subscribers so the desktop repaints", () => {
    const store = createDesktopIconsStore(() => storage().access);
    let seen = 0;
    const stop = store.subscribe(() => {
      seen++;
    });
    store.set("workspace-v1-aaa", [icon("a", 0, 0)]);
    expect(seen).toBe(1);
    stop();
    store.set("workspace-v1-aaa", []);
    expect(seen).toBe(1);
  });

  it("separates preview layouts from real ones", () => {
    expect(desktopIconsStorageKey(true)).toBe("shellcanvas.desktop-icons");
    expect(desktopIconsStorageKey(false)).toBe(
      "shellcanvas.desktop-icons.preview",
    );
  });
});
