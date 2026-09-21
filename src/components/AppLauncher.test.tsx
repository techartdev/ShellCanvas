// SPDX-License-Identifier: MPL-2.0
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FolderClosed, SquareTerminal } from "lucide-react";
import type { DesktopApp } from "../sdk";
import { AppLauncher, handleLauncherContextMenuKey } from "./AppLauncher";

const app = (
  id: string,
  title: string,
  extra: Partial<DesktopApp> = {},
): DesktopApp => ({
  apiVersion: 1,
  id,
  title,
  subtitle: `${title} subtitle`,
  scope: "local",
  requires: [],
  icon: FolderClosed,
  component: () => null,
  ...extra,
});
const image = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')}`;

it("opens the app menu from keyboard context-menu keys without launching", () => {
  const opened: string[] = [];
  let prevented = false;
  const handled = handleLauncherContextMenuKey(
    {
      key: "F10",
      shiftKey: true,
      preventDefault: () => {
        prevented = true;
      },
    },
    app("notes", "Notes"),
    (item) => opened.push(item.id),
    { left: 12, top: 34 },
  );
  expect(handled).toBe(true);
  expect(prevented).toBe(true);
  expect(opened).toEqual(["notes"]);
});

it("accepts the dedicated context-menu key and ignores ordinary launch keys", () => {
  const opened: string[] = [];
  let prevented = 0;
  const item = app("notes", "Notes");
  const menu = (selected: DesktopApp) => opened.push(selected.id);
  const bounds = { left: 2, top: 3 };

  expect(
    handleLauncherContextMenuKey(
      {
        key: "ContextMenu",
        shiftKey: false,
        preventDefault: () => prevented++,
      },
      item,
      menu,
      bounds,
    ),
  ).toBe(true);
  expect(
    handleLauncherContextMenuKey(
      { key: "Enter", shiftKey: false, preventDefault: () => prevented++ },
      item,
      menu,
      bounds,
    ),
  ).toBe(false);
  expect(prevented).toBe(1);
  expect(opened).toEqual(["notes"]);
});

it("lists apps as large icons with running and unavailable states", () => {
  const markup = renderToStaticMarkup(
    <AppLauncher
      apps={[
        app("files", "Files"),
        app("org.example.notes", "Notes", {
          image,
          description: "Quick notes",
        }),
        app("terminal", "Terminal", { icon: SquareTerminal }),
      ]}
      running={(id) => id === "files"}
      blocked={(item) =>
        item.id === "terminal" ? "Connect a host with a terminal" : undefined
      }
      launch={() => {}}
      close={() => {}}
      connect={() => {}}
    />,
  );
  expect(markup).toContain('role="dialog"');
  expect(markup).toContain('aria-label="App launcher"');
  expect(markup).toContain('aria-label="Search apps"');
  expect(markup).toContain('aria-label="Files, running"');
  expect(markup).toContain("app-launcher-running");
  // Installed apps show their artwork and describe themselves on hover.
  expect(markup).toContain(`src="${image}"`);
  expect(markup).toContain('title="Quick notes"');
  // Bundled apps without a description fall back to their subtitle.
  expect(markup).toContain('title="Files subtitle"');
  expect(markup).toContain(
    'aria-label="Terminal, unavailable: Connect a host with a terminal"',
  );
  expect(markup).toContain('aria-disabled="true"');
  // The reason is visible, not only a hover tooltip.
  expect(markup).toContain(
    '<small class="app-launcher-note">Connect a host with a terminal</small>',
  );
  expect(markup).not.toContain(">Unavailable<");
  expect(markup.match(/data-size="launcher"/g)).toHaveLength(3);
  expect(markup).not.toContain("No apps match");
});
