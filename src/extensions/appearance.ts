// SPDX-License-Identifier: MPL-2.0
import type { AppEnvironment } from "./environment-api";

const keys = [
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
] as const;

/** Presentation metadata only: never export arbitrary CSS, wallpaper URLs or storage. */
export function readAppAppearance(
  root = document.documentElement,
): NonNullable<AppEnvironment["appearance"]> {
  const style = getComputedStyle(root);
  const colors: Record<string, string> = {};
  for (const key of keys) {
    const value = style.getPropertyValue(`--sc-${key}`).trim();
    if (/^#[0-9a-f]{6}$/i.test(value)) colors[key] = value;
  }
  return {
    mode: root.dataset.themeMode === "light" ? "light" : "dark",
    colors,
  };
}

export function watchAppAppearance(
  changed: () => void,
  root = document.documentElement,
): () => void {
  let previous = JSON.stringify(readAppAppearance(root));
  const observer = new MutationObserver(() => {
    const next = JSON.stringify(readAppAppearance(root));
    if (next !== previous) {
      previous = next;
      changed();
    }
  });
  observer.observe(root, {
    attributes: true,
    attributeFilter: ["style", "data-theme-mode", "data-theme"],
  });
  return () => observer.disconnect();
}
