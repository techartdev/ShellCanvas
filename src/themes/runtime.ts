// SPDX-License-Identifier: MPL-2.0
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { usePreferences } from "../preferences";
import { canvasTheme, resolveTheme } from "./model";
import { useThemes } from "./store";
import { readWallpaper, watchWallpaper } from "./wallpaper";
import "./theme.css";

const fonts = {
  system: 'Inter, "Segoe UI Variable", "Segoe UI", system-ui, sans-serif',
  humanist: '"Avenir Next", "Trebuchet MS", system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
};
export function useTheme() {
  const { values } = usePreferences();
  const { themes } = useThemes();
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);
  const theme =
    themes.find((theme) => theme.id === values.themeId) ?? canvasTheme;
  const requested =
    values.themeMode === "system"
      ? systemDark
        ? "dark"
        : "light"
      : values.themeMode;
  const resolved = useMemo(
    () => resolveTheme(theme, requested),
    [theme, requested],
  );
  return { theme, ...resolved, missing: theme.id !== values.themeId };
}

/** Global tokens also reach portaled menus and native/polyfilled dialogs. */
export function useDesktopTheme() {
  const { values, set } = usePreferences();
  const { theme, mode, style } = useTheme();
  useEffect(() => {
    const recover = (event: KeyboardEvent) => {
      if (
        !event.repeat &&
        (event.ctrlKey || event.metaKey) &&
        event.altKey &&
        event.shiftKey &&
        event.key.toLowerCase() === "r"
      ) {
        event.preventDefault();
        set("themeId", canvasTheme.id);
        set("themeMode", "dark");
        set("uiScale", 100);
        set("toolbarHeight", 0);
        set("dockSize", 0);
        set("wallpaper", "theme");
      }
    };
    window.addEventListener("keydown", recover);
    return () => window.removeEventListener("keydown", recover);
  }, [set]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme.id;
    root.dataset.themeMode = mode;
    root.style.colorScheme = mode;
    root.style.fontSize = `${(13 * values.uiScale) / 100}px`;
    root.style.fontFamily = fonts[style.font ?? "system"];
    for (const [key, value] of Object.entries(style.colors))
      root.style.setProperty(`--sc-${key}`, value);
    for (const [key, value] of Object.entries(style.colors)) {
      const hex = value.slice(1);
      root.style.setProperty(
        `--sc-${key}-rgb`,
        [0, 2, 4]
          .map((offset) => parseInt(hex.slice(offset, offset + 2), 16))
          .join(","),
      );
    }
    root.style.setProperty("--sc-color-scheme", mode);
    root.style.setProperty(
      "--sc-window-radius",
      `${style.windowRadius! / 13}rem`,
    );
    root.style.setProperty(
      "--sc-window-header",
      `${style.windowHeader! / 13}rem`,
    );
    root.style.setProperty("--sc-dock-radius", `${style.dockRadius! / 13}rem`);
    root.style.setProperty("--sc-blur", `${style.blur}px`);
    root.style.setProperty(
      "--sc-toolbar-height",
      `${(values.toolbarHeight || style.toolbarHeight!) / 13}rem`,
    );
    root.style.setProperty(
      "--sc-dock-size",
      `${(values.dockSize || style.dockSize!) / 13}rem`,
    );
  }, [
    theme,
    mode,
    style,
    values.uiScale,
    values.toolbarHeight,
    values.dockSize,
  ]);
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    let url: string | undefined;
    const root = document.documentElement;
    async function update() {
      const request = ++revision;
      try {
        const blob =
          values.wallpaper === "custom" ? await readWallpaper() : undefined;
        if (disposed || request !== revision) return;
        const next = blob ? URL.createObjectURL(blob) : undefined;
        root.style.setProperty(
          "--sc-wallpaper-image",
          next ? `url("${next}")` : "none",
        );
        root.dataset.customWallpaper = next ? "true" : "false";
        if (url) URL.revokeObjectURL(url);
        url = next;
      } catch {
        if (!disposed && request === revision)
          root.dataset.customWallpaper = "false";
      }
    }
    void update();
    const stop = watchWallpaper(() => {
      void update();
    });
    return () => {
      disposed = true;
      stop();
      if (url) URL.revokeObjectURL(url);
    };
  }, [values.wallpaper]);
  useLayoutEffect(() => {
    document.documentElement.dataset.wallpaperFit = values.wallpaperFit;
  }, [values.wallpaperFit]);
}
