// SPDX-License-Identifier: MPL-2.0
export const colorKeys = [
  "base",
  "surface",
  "raised",
  "inset",
  "text",
  "muted",
  "accent",
  "onAccent",
  "border",
  "hover",
  "selection",
  "danger",
  "dangerSoft",
  "warning",
  "warningSoft",
  "success",
  "shadow",
  "scrim",
  "terminal",
  "terminalText",
  "sky",
  "glow",
  "far",
  "mid",
  "near",
] as const;
export type ThemeColors = Record<(typeof colorKeys)[number], string>;
export type ThemeMode = "light" | "dark";
export interface ThemeStyle {
  colors: Partial<ThemeColors>;
  windowRadius?: number;
  windowHeader?: number;
  dockRadius?: number;
  blur?: number;
  toolbarHeight?: number;
  dockSize?: number;
  font?: "system" | "humanist" | "serif" | "mono";
}
export interface CanvasTheme {
  format: 1;
  kind: "shellcanvas-theme";
  id: string;
  version: string;
  name: string;
  author?: string;
  description?: string;
  variants: { light?: ThemeStyle; dark?: ThemeStyle };
}
export const themeLimit = 32768;
export const themeId = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
export const ranges = {
  windowRadius: [0, 24],
  windowHeader: [32, 60],
  dockRadius: [0, 28],
  blur: [0, 40],
  toolbarHeight: [36, 64],
  dockSize: [32, 64],
} as const;
const fonts = ["system", "humanist", "serif", "mono"];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a theme object.");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`Unknown theme field: ${key}`);
}
function string(value: unknown, max: number, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new Error(`Invalid ${label}.`);
  return value;
}
/** Closed, data-only contract. Never interpolate arbitrary CSS, selectors or URLs. */
export function parseTheme(raw: string): CanvasTheme {
  if (new TextEncoder().encode(raw).length > themeLimit)
    throw new Error("Theme files must be 32 KB or smaller.");
  const data = object(JSON.parse(raw));
  keys(data, [
    "format",
    "kind",
    "id",
    "version",
    "name",
    "author",
    "description",
    "variants",
  ]);
  if (data.format !== 1 || data.kind !== "shellcanvas-theme")
    throw new Error("Unsupported theme format.");
  const id = string(data.id, 120, "theme ID");
  if (!themeId.test(id))
    throw new Error("Use a namespaced theme ID, such as studio.my-theme.");
  const version = string(data.version, 40, "version");
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
    throw new Error("Use a semantic version, such as 1.0.0.");
  const variants = object(data.variants);
  keys(variants, ["light", "dark"]);
  if (!Object.keys(variants).length)
    throw new Error("Include a light or dark variant.");
  const result: CanvasTheme = {
    format: 1,
    kind: "shellcanvas-theme",
    id,
    version,
    name: string(data.name, 80, "theme name"),
    variants: {},
  };
  for (const key of ["author", "description"] as const)
    if (data[key] !== undefined)
      result[key] = string(data[key], key === "author" ? 100 : 500, key);
  for (const mode of ["light", "dark"] as const) {
    if (!(mode in variants)) continue;
    const variant = object(variants[mode]);
    keys(variant, ["colors", "font", ...Object.keys(ranges)]);
    const colors = object(variant.colors ?? {});
    keys(colors, colorKeys);
    const style: ThemeStyle = { colors: {} };
    for (const key of colorKeys) {
      if (colors[key] === undefined) continue;
      if (
        typeof colors[key] !== "string" ||
        !/^#[a-fA-F0-9]{6}$/.test(colors[key])
      )
        throw new Error(`${mode}.${key} must be an opaque #RRGGBB color.`);
      style.colors[key] = colors[key];
    }
    for (const key of Object.keys(ranges) as (keyof typeof ranges)[]) {
      const number = variant[key];
      if (number === undefined) continue;
      const [min, max] = ranges[key];
      if (
        typeof number !== "number" ||
        !Number.isInteger(number) ||
        number < min ||
        number > max
      )
        throw new Error(`${key} must be between ${min} and ${max}.`);
      style[key] = number;
    }
    if (variant.font !== undefined) {
      if (typeof variant.font !== "string" || !fonts.includes(variant.font))
        throw new Error("Unknown theme font.");
      style.font = variant.font as ThemeStyle["font"];
    }
    result.variants[mode] = style;
  }
  return result;
}

export const canvasTheme: CanvasTheme = {
  format: 1,
  kind: "shellcanvas-theme",
  id: "org.shellcanvas.canvas",
  version: "1.0.0",
  name: "Canvas",
  author: "ShellCanvas",
  description:
    "Quiet alpine mornings. Deep, restful evenings. One workspace, in two lights.",
  variants: {
    dark: {
      colors: {
        base: "#122330",
        surface: "#1b2b36",
        raised: "#263943",
        inset: "#15242f",
        text: "#e0e9ea",
        muted: "#a1b8c2",
        accent: "#a3d9c4",
        onAccent: "#173a30",
        border: "#405660",
        hover: "#2b414b",
        selection: "#35564f",
        danger: "#f1a7a7",
        dangerSoft: "#452f36",
        warning: "#e5c68a",
        warningSoft: "#3f3a30",
        success: "#a3d9b8",
        shadow: "#07121b",
        scrim: "#07121b",
        terminal: "#111d27",
        terminalText: "#d4e2e7",
        sky: "#193e50",
        glow: "#8cad9f",
        far: "#54757b",
        mid: "#304f5d",
        near: "#18333f",
      },
      windowRadius: 14,
      windowHeader: 43,
      dockRadius: 20,
      blur: 24,
      toolbarHeight: 44,
      dockSize: 42,
      font: "system",
    },
    light: {
      colors: {
        base: "#e9eeeb",
        surface: "#f8faf7",
        raised: "#edf2ee",
        inset: "#e5ece7",
        text: "#223b3c",
        muted: "#516b6c",
        accent: "#296e60",
        onAccent: "#ffffff",
        border: "#c0d0c8",
        hover: "#e1eae3",
        selection: "#c8e1d4",
        danger: "#a02f3d",
        dangerSoft: "#f8e6e5",
        warning: "#795916",
        warningSoft: "#f3ead5",
        success: "#2e7451",
        shadow: "#3c5854",
        scrim: "#304d47",
        terminal: "#f3f7f1",
        terminalText: "#243c36",
        sky: "#d4e4df",
        glow: "#fff0cb",
        far: "#9fbdb8",
        mid: "#799f9b",
        near: "#527e7c",
      },
      windowRadius: 14,
      windowHeader: 43,
      dockRadius: 20,
      blur: 24,
      toolbarHeight: 44,
      dockSize: 42,
      font: "system",
    },
  },
};
export function resolveTheme(theme: CanvasTheme, requested: ThemeMode) {
  const mode = theme.variants[requested]
    ? requested
    : requested === "dark"
      ? "light"
      : "dark";
  const base = canvasTheme.variants[mode]!;
  const variant = theme.variants[mode]!;
  return {
    mode,
    style: {
      ...base,
      ...variant,
      colors: { ...base.colors, ...variant.colors } as ThemeColors,
    },
  };
}
