// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, it, vi } from "vitest";
import { readAppAppearance, watchAppAppearance } from "./appearance";

afterEach(() => vi.unstubAllGlobals());

it("exports only known literal colors and follows meaningful theme changes", () => {
  const root = { dataset: { themeMode: "dark" } } as unknown as HTMLElement;
  const tokens: Record<string, string> = {
    "--sc-accent": " #7ab8ff ",
    "--sc-base": "url(private-wallpaper)",
    "--sc-private": "#ffffff",
  };
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (key: string) => tokens[key] ?? "",
  }));
  let mutate = () => {};
  const disconnect = vi.fn();
  const observe = vi.fn();
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        mutate = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  expect(readAppAppearance(root)).toEqual({
    mode: "dark",
    colors: { accent: "#7ab8ff" },
  });
  const changed = vi.fn();
  const stop = watchAppAppearance(changed, root);
  mutate();
  tokens["--sc-private"] = "#000000";
  mutate();
  expect(changed).not.toHaveBeenCalled();
  root.dataset.themeMode = "light";
  tokens["--sc-accent"] = "#005fb8";
  mutate();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(readAppAppearance(root)).toEqual({
    mode: "light",
    colors: { accent: "#005fb8" },
  });
  expect(observe).toHaveBeenCalledWith(root, {
    attributes: true,
    attributeFilter: ["style", "data-theme-mode", "data-theme"],
  });
  stop();
  expect(disconnect).toHaveBeenCalledOnce();
});
