// SPDX-License-Identifier: MPL-2.0
import { useSyncExternalStore } from "react";
import { canvasTheme, parseTheme, type CanvasTheme } from "./model";
export const themesKey = "shellcanvas.themes";
type StorageAccess = Pick<Storage, "getItem" | "setItem">;
export function createThemeStore(storage: () => StorageAccess) {
  let snapshot: { themes: CanvasTheme[]; error: string; blocked: boolean };
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  function read() {
    try {
      const raw = storage().getItem(themesKey);
      if (raw && raw.length > 1024 * 1024)
        throw new Error("Oversized theme collection.");
      const data = raw ? JSON.parse(raw) : { version: 1, themes: [] };
      if (
        data.version !== 1 ||
        !Array.isArray(data.themes) ||
        data.themes.length > 24
      )
        throw new Error("Unknown collection format.");
      const themes: CanvasTheme[] = data.themes.map((theme: unknown) =>
        parseTheme(JSON.stringify(theme)),
      );
      if (
        themes.some((theme) => theme.id === canvasTheme.id) ||
        new Set(themes.map((theme) => theme.id)).size !== themes.length
      )
        throw new Error("Duplicate theme ID.");
      snapshot = {
        themes: [canvasTheme, ...themes],
        error: "",
        blocked: false,
      };
    } catch {
      snapshot = {
        themes: [canvasTheme],
        error:
          "Saved themes could not be read. Canvas is available; export or back up the saved collection before resetting it.",
        blocked: true,
      };
    }
  }
  read();
  function save(themes: CanvasTheme[], reset = false) {
    if (snapshot.blocked && !reset) throw new Error(snapshot.error);
    // Commit storage before changing the active catalog. Failed writes keep the old collection.
    storage().setItem(
      themesKey,
      JSON.stringify({
        version: 1,
        themes: themes.filter((theme) => theme.id !== canvasTheme.id),
      }),
    );
    snapshot = { themes, error: "", blocked: false };
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
    install(theme: CanvasTheme) {
      const safe = parseTheme(JSON.stringify(theme));
      if (safe.id === canvasTheme.id)
        throw new Error("The built-in Canvas theme cannot be replaced.");
      const themes = snapshot.themes.filter((item) => item.id !== safe.id);
      if (themes.length >= 25)
        throw new Error(
          "Remove an installed theme before adding another (24 installed themes).",
        );
      save([...themes, safe]);
    },
    remove(id: string) {
      if (id === canvasTheme.id) throw new Error("Canvas is built in.");
      save(snapshot.themes.filter((theme) => theme.id !== id));
    },
    reset() {
      save([canvasTheme], true);
    },
    reload() {
      read();
      notify();
    },
  };
}
let store: ReturnType<typeof createThemeStore> | undefined;
export function useThemes() {
  if (!store) {
    store = createThemeStore(() => localStorage);
    window.addEventListener("storage", (event) => {
      if (event.key === themesKey || event.key === null) store?.reload();
    });
  }
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return {
    ...snapshot,
    install: store.install,
    remove: store.remove,
    reset: store.reset,
  };
}
