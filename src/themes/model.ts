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
  version: "1.1.0",
  name: "Canvas",
  author: "ShellCanvas",
  description:
    "Clean white. Quiet charcoal. A familiar desktop, with a clear blue accent.",
  variants: {
    dark: {
      colors: {
        base: "#19191c",
        surface: "#242427",
        raised: "#303034",
        inset: "#1d1d20",
        text: "#f2f2f5",
        muted: "#b0b0ba",
        accent: "#7ab8ff",
        onAccent: "#102745",
        border: "#48484f",
        hover: "#39393f",
        selection: "#293f5b",
        danger: "#f1a7a7",
        dangerSoft: "#462d33",
        warning: "#f2c572",
        warningSoft: "#413527",
        success: "#91d6a3",
        shadow: "#08080d",
        scrim: "#111118",
        terminal: "#161619",
        terminalText: "#e5e5ea",
        sky: "#102655",
        glow: "#536dd4",
        far: "#455b96",
        mid: "#293c72",
        near: "#172345",
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
        base: "#f0f0f3",
        surface: "#fafafa",
        raised: "#f0f0f3",
        inset: "#e8e8ed",
        text: "#202024",
        muted: "#585861",
        accent: "#005fb8",
        onAccent: "#ffffff",
        border: "#c9c9d1",
        hover: "#e2e2e8",
        selection: "#d6e7fb",
        danger: "#a02f3d",
        dangerSoft: "#f8e6e5",
        warning: "#805400",
        warningSoft: "#fff1d6",
        success: "#26733b",
        shadow: "#252535",
        scrim: "#242432",
        terminal: "#ffffff",
        terminalText: "#242429",
        sky: "#dde8ff",
        glow: "#f4edff",
        far: "#a6b7e2",
        mid: "#748dc3",
        near: "#3b558c",
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
