// SPDX-License-Identifier: MPL-2.0
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FolderClosed, SquareTerminal } from "lucide-react";
import type { DesktopApp } from "../sdk";
import { AppLauncher } from "./AppLauncher";

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
  expect(markup.match(/data-size="launcher"/g)).toHaveLength(3);
  expect(markup).not.toContain("No apps match");
});
