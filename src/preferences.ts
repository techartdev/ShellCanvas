// SPDX-License-Identifier: MPL-2.0
import { useSyncExternalStore } from "react";

export interface Preferences {
  wallpaper: "fjord" | "dusk" | "sage";
  clockFormat: "system" | "12" | "24";
  clockSeconds: boolean;
  reduceMotion: boolean;
  terminalFontSize: number;
  terminalCursor: "bar" | "block" | "underline";
  terminalBlink: boolean;
  terminalScrollback: number;
  editorFontSize: number;
  editorWrap: boolean;
  editorLineNumbers: boolean;
  editorIndent: "2" | "4" | "tab";
  filesShowHidden: boolean;
  filesFoldersFirst: boolean;
  filesSort: "name" | "modified" | "size";
  filesDescending: boolean;
  filesCompact: boolean;
}
export const defaultPreferences: Readonly<Preferences> = Object.freeze({
  wallpaper: "fjord",
  clockFormat: "system",
  clockSeconds: false,
  reduceMotion: false,
  terminalFontSize: 13,
  terminalCursor: "bar",
  terminalBlink: true,
  terminalScrollback: 3000,
  editorFontSize: 13,
  editorWrap: false,
  editorLineNumbers: true,
  editorIndent: "2",
  filesShowHidden: true,
  filesFoldersFirst: true,
  filesSort: "name",
  filesDescending: false,
  filesCompact: false,
});
export const preferencesKey = "shellcanvas.preferences";
type StorageAccess = Pick<Storage, "getItem" | "setItem">;
export interface PreferencesSnapshot {
  values: Readonly<Preferences>;
  error: string;
  blocked: boolean;
}
function normalise(input: unknown): Preferences {
  const values = { ...defaultPreferences };
  if (!input || typeof input !== "object" || Array.isArray(input))
    return values;
  const data = input as Record<string, unknown>;
  const choices = {
    wallpaper: ["fjord", "dusk", "sage"],
    clockFormat: ["system", "12", "24"],
    terminalCursor: ["bar", "block", "underline"],
    editorIndent: ["2", "4", "tab"],
    filesSort: ["name", "modified", "size"],
  };
  for (const key of Object.keys(values) as (keyof Preferences)[]) {
    const value = data[key];
    if (typeof values[key] === "boolean" && typeof value === "boolean")
      Object.assign(values, { [key]: value });
    else if (
      key in choices &&
      typeof value === "string" &&
      choices[key as keyof typeof choices].includes(value)
    )
      Object.assign(values, { [key]: value });
    else if (
      typeof values[key] === "number" &&
      typeof value === "number" &&
      Number.isInteger(value)
    ) {
      const [min, max] =
        key === "terminalScrollback" ? [100, 100000] : [11, 24];
      if (value >= min && value <= max) Object.assign(values, { [key]: value });
    }
  }
  return values;
}

/** Non-secret local preferences. Never silently replace a corrupt/future store. */
export function createPreferencesStore(storage: () => StorageAccess) {
  let snapshot: PreferencesSnapshot;
  const listeners = new Set<() => void>();
  function read(): PreferencesSnapshot {
    try {
      const target = storage();
      const raw = target.getItem(preferencesKey);
      if (!raw) {
        const wallpaper =
          target.getItem("shellcanvas.wallpaper") ||
          target.getItem("sshdesktop.wallpaper");
        return { values: normalise({ wallpaper }), error: "", blocked: false };
      }
      const stored = JSON.parse(raw);
      if (
        stored?.version !== 1 ||
        !stored.values ||
        typeof stored.values !== "object" ||
        Array.isArray(stored.values)
      )
        throw new Error("Unknown preference format");
      return { values: normalise(stored.values), error: "", blocked: false };
    } catch {
      return {
        values: defaultPreferences,
        blocked: true,
        error:
          "Saved preferences could not be read. Defaults are in use. Restore defaults to replace the saved preferences.",
      };
    }
  }
  snapshot = read();
  const notify = () => listeners.forEach((listener) => listener());
  function save(values: Readonly<Preferences>, reset = false) {
    if (snapshot.blocked && !reset) return;
    try {
      storage().setItem(preferencesKey, JSON.stringify({ version: 1, values }));
      snapshot = { values, error: "", blocked: false };
    } catch {
      snapshot = {
        values,
        blocked: false,
        error:
          "These changes apply for now, but could not be saved on this device. Try again or check available storage.",
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
    set<K extends keyof Preferences>(key: K, value: Preferences[K]) {
      save(normalise({ ...snapshot.values, [key]: value }));
    },
    reset() {
      save(defaultPreferences, true);
    },
    reload() {
      snapshot = read();
      notify();
    },
  };
}
let store: ReturnType<typeof createPreferencesStore> | undefined;
function getStore() {
  if (!store) {
    store = createPreferencesStore(() => window.localStorage);
    window.addEventListener("storage", (event) => {
      if (event.key === preferencesKey || event.key === null) store?.reload();
    });
  }
  return store;
}
export function usePreferences() {
  const current = getStore();
  const snapshot = useSyncExternalStore(current.subscribe, current.getSnapshot);
  return { ...snapshot, set: current.set, reset: current.reset };
}
