import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopIcons } from "./DesktopIcons";
import type { DesktopShortcut } from "../desktop-icons";
import type { DesktopApp } from "../sdk";

const filesApp = {
  id: "files",
  title: "Files",
} as unknown as DesktopApp;

const shortcut = (over: Partial<DesktopShortcut> = {}): DesktopShortcut => ({
  id: "one",
  kind: "app",
  target: "files",
  name: "Files",
  column: 0,
  row: 0,
  ...over,
});

const render = (
  icons: DesktopShortcut[],
  unavailable?: (icon: DesktopShortcut) => string,
) =>
  renderToStaticMarkup(
    <DesktopIcons
      icons={icons}
      apps={[filesApp]}
      unavailable={unavailable}
      open={() => {}}
      move={() => {}}
      menu={() => {}}
    />,
  );

describe("the desktop icon layer", () => {
  it("tiles each shortcut at its own cell", () => {
    const markup = render([
      shortcut(),
      shortcut({ id: "two", column: 2, row: 3, name: "Terminal" }),
    ]);
    expect(markup).toContain("left:0");
    expect(markup).toContain("left:184px");
    expect(markup).toContain("top:300px");
    // The cell size the layout module uses reaches the stylesheet.
    expect(markup).toContain("--icon-cell-width:92px");
  });

  it("tells a person which kind of shortcut each one is", () => {
    const markup = render([
      shortcut(),
      shortcut({
        id: "two",
        kind: "folder",
        target: "/srv/deploy",
        name: "deploy",
      }),
    ]);
    expect(markup).toContain('aria-label="Files, app shortcut"');
    expect(markup).toContain('aria-label="deploy, folder shortcut"');
  });

  it("shows a folder its own location, since the name alone is ambiguous", () => {
    const markup = render([
      shortcut({ kind: "folder", target: "/srv/deploy", name: "deploy" }),
    ]);
    expect(markup).toContain('title="/srv/deploy"');
  });

  it("marks a shortcut that cannot open, and says why", () => {
    const markup = render([shortcut()], () => "Connect a host first.");
    expect(markup).toContain("unavailable");
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain('title="Connect a host first."');
  });

  it("renders nothing but the ground when the desktop is empty", () => {
    const markup = render([]);
    expect(markup).toContain('class="desktop-icons"');
    expect(markup).not.toContain("desktop-icon ");
  });
});
