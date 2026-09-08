// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import {
  createPreferencesStore,
  defaultPreferences,
  preferencesKey,
} from "./preferences";

function storage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}
describe("local preferences", () => {
  it("migrates wallpaper and persists values across fresh reads without other local data", () => {
    const disk = storage();
    disk.setItem("sshdesktop.wallpaper", "sage");
    const store = createPreferencesStore(() => disk);
    expect(store.getSnapshot().values.wallpaper).toBe("sage");
    store.set("terminalFontSize", 18);
    store.set("filesShowHidden", false);
    expect(createPreferencesStore(() => disk).getSnapshot().values).toEqual({
      ...defaultPreferences,
      wallpaper: "sage",
      terminalFontSize: 18,
      filesShowHidden: false,
    });
    expect(disk.getItem(preferencesKey)).not.toContain("password");
  });
  it("bounds corrupted fields and retains valid fields", () => {
    const disk = storage();
    disk.setItem(
      preferencesKey,
      JSON.stringify({
        version: 1,
        values: {
          terminalFontSize: 1000,
          terminalScrollback: -1,
          editorIndent: "8",
          filesShowHidden: "false",
          wallpaper: "dusk",
          editorWrap: true,
        },
      }),
    );
    expect(createPreferencesStore(() => disk).getSnapshot().values).toEqual({
      ...defaultPreferences,
      wallpaper: "dusk",
      editorWrap: true,
    });
  });
  it("does not overwrite corrupt or future formats until explicit reset", () => {
    for (const raw of ["{invalid", '{"version":2,"values":{}}']) {
      const disk = storage();
      disk.setItem(preferencesKey, raw);
      const store = createPreferencesStore(() => disk);
      expect(store.getSnapshot().blocked).toBe(true);
      store.set("wallpaper", "dusk");
      expect(disk.getItem(preferencesKey)).toBe(raw);
      store.reset();
      expect(createPreferencesStore(() => disk).getSnapshot().values).toEqual(
        defaultPreferences,
      );
    }
  });
  it("reports storage failure and updates subscribers without claiming persistence", () => {
    const disk = storage();
    const store = createPreferencesStore(() => ({
      ...disk,
      setItem: () => {
        throw new Error("full");
      },
    }));
    let calls = 0;
    const stop = store.subscribe(() => {
      calls++;
    });
    store.set("editorFontSize", 16);
    expect(store.getSnapshot().values.editorFontSize).toBe(16);
    expect(store.getSnapshot().error).toContain("could not be saved");
    expect(calls).toBe(1);
    stop();
    store.reset();
    expect(calls).toBe(1);
  });
});
