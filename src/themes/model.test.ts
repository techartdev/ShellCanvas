// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import {
  canvasTheme,
  colorKeys,
  parseTheme,
  ranges,
  resolveTheme,
} from "./model";
import { createThemeStore, themesKey } from "./store";
import examplePackage from "../../examples/themes/canvas-study/shellcanvas.theme.json";
import schema from "../../docs/schemas/theme.schema.json";
const example = () => ({
  format: 1,
  kind: "shellcanvas-theme",
  id: "studio.paper",
  version: "1.0.0",
  name: "Paper",
  variants: { light: { colors: { accent: "#336699" }, windowRadius: 0 } },
});
const parse = (value: unknown) => parseTheme(JSON.stringify(value));
function disk() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}
describe("declarative theme contract", () => {
  it("ships an independently installable example and a schema matching the public knobs", () => {
    const theme = parse(examplePackage);
    expect(theme.id).not.toBe(canvasTheme.id);
    expect(theme.variants).toEqual(canvasTheme.variants);
    const properties = schema.properties.variants.properties.dark.properties;
    expect(Object.keys(properties.colors.properties)).toEqual([...colorKeys]);
    for (const [key, [min, max]] of Object.entries(ranges)) {
      expect(properties[key as keyof typeof properties]).toMatchObject({
        type: "integer",
        minimum: min,
        maximum: max,
      });
    }
  });
  it("roundtrips the complete paired design and resolves partial, single-mode themes", () => {
    expect(parse(canvasTheme)).toEqual(canvasTheme);
    const resolved = resolveTheme(parse(example()), "dark");
    expect(resolved.mode).toBe("light");
    expect(resolved.style.windowRadius).toBe(0);
    expect(resolved.style.colors.accent).toBe("#336699");
    expect(resolved.style.colors.text).toBe(
      canvasTheme.variants.light!.colors.text,
    );
    expect(Object.keys(resolved.style.colors)).toHaveLength(colorKeys.length);
  });
  it("rejects executable style values, unknown fields and ambiguous formats", () => {
    for (const colors of [
      { accent: "url(https://example.org/track)" },
      { text: "var(--secret)" },
      { surface: "#fff" },
      { accent: "#33669900" },
      { unknown: "#ffffff" },
      { __proto__: null, constructor: "#ffffff" },
    ])
      expect(() =>
        parse({ ...example(), variants: { dark: { colors } } }),
      ).toThrow();
    for (const change of [
      { format: 2 },
      { kind: "app" },
      { id: "__proto__" },
      { variants: {} },
      { variants: { light: { css: "body{display:none}" } } },
      { scripts: [] },
      { version: "latest" },
    ])
      expect(() => parse({ ...example(), ...change })).toThrow();
    expect(() => parseTheme(" ".repeat(32769))).toThrow("32 KB");
  });
  it("bounds every numeric customization and accepts valid boundary values", () => {
    for (const [key, [min, max]] of Object.entries(ranges)) {
      for (const value of [min, max])
        expect(
          parse({ ...example(), variants: { dark: { [key]: value } } }).variants
            .dark,
        ).toHaveProperty(key, value);
      for (const value of [min - 1, max + 1, 1.5, "20"])
        expect(() =>
          parse({ ...example(), variants: { dark: { [key]: value } } }),
        ).toThrow();
    }
  });
  it("keeps the built-in text, accent and status colors readable in both variants", () => {
    const luminance = (hex: string) => {
      const values = [1, 3, 5]
        .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    const contrast = (a: string, b: string) => {
      const x = luminance(a),
        y = luminance(b);
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    for (const mode of ["dark", "light"] as const) {
      const colors = resolveTheme(canvasTheme, mode).style.colors;
      for (const foreground of [
        "text",
        "muted",
        "accent",
        "danger",
        "warning",
        "success",
      ] as const)
        for (const background of ["surface", "inset", "raised"] as const)
          expect(
            contrast(colors[foreground], colors[background]),
            `${mode} ${foreground}/${background}`,
          ).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.onAccent, colors.accent)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(
        contrast(colors.terminalText, colors.terminal),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
describe("installed theme collection", () => {
  it("persists install, explicit replacement and removal without replacing Canvas", () => {
    const storage = disk();
    const store = createThemeStore(() => storage);
    store.install(parse(example()));
    store.install(parse({ ...example(), version: "1.1.0" }));
    expect(
      createThemeStore(() => storage)
        .getSnapshot()
        .themes.map((theme) => theme.version),
    ).toEqual(["1.0.0", "1.1.0"]);
    expect(() => store.install(canvasTheme)).toThrow("cannot be replaced");
    expect(() => store.remove(canvasTheme.id)).toThrow("built in");
    store.remove("studio.paper");
    expect(createThemeStore(() => storage).getSnapshot().themes).toEqual([
      canvasTheme,
    ]);
  });
  it("retains unreadable/future collections until explicitly reset", () => {
    for (const raw of [
      "broken",
      '{"version":2,"themes":[]}',
      JSON.stringify({ version: 1, themes: [example(), example()] }),
    ]) {
      const storage = disk();
      storage.setItem(themesKey, raw);
      const store = createThemeStore(() => storage);
      expect(store.getSnapshot().blocked).toBe(true);
      expect(() => store.install(parse(example()))).toThrow();
      expect(storage.getItem(themesKey)).toBe(raw);
      store.reset();
      expect(store.getSnapshot().blocked).toBe(false);
    }
  });
  it("does not claim a failed write installed a theme", () => {
    const store = createThemeStore(() => ({
      getItem: () => null,
      setItem: () => {
        throw new Error("full");
      },
    }));
    expect(() => store.install(parse(example()))).toThrow("full");
    expect(store.getSnapshot().themes).toEqual([canvasTheme]);
  });
});
