// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import { FolderClosed } from "lucide-react";
import type { DesktopAction } from "./desktop";
import { launcherMenuActions } from "./launcher-actions";
import type { DesktopApp } from "./sdk";

const app = (multiple = false): DesktopApp => ({
  apiVersion: 1,
  id: "notes",
  title: "Notes",
  subtitle: "Notes subtitle",
  scope: "local",
  requires: [],
  icon: FolderClosed,
  component: () => null,
  window: { multiple },
});

describe("launcher app menu actions", () => {
  it("closes the launcher before opening or focusing a window", () => {
    const events: Array<string | DesktopAction> = [];
    const actions = launcherMenuActions({
      app: app(true),
      unavailable: false,
      canPin: true,
      windows: [{ id: "notes:2", label: "Notes 2 · Minimized" }],
      closeLauncher: () => events.push("close"),
      dispatch: (action) => events.push(action),
      pin: () => events.push("pin"),
    });

    expect(actions.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "open", label: "New Notes window" },
      { id: "pin", label: "Add to desktop" },
      { id: "notes:2", label: "Notes 2 · Minimized" },
    ]);
    actions[0].run();
    actions[2].run();
    actions[1].run();
    expect(events).toEqual([
      "close",
      { type: "new", id: "notes" },
      "close",
      { type: "focus", id: "notes:2" },
      "pin",
    ]);
  });

  it("keeps app availability and desktop pin availability independent", () => {
    const unavailableApp = launcherMenuActions({
      app: app(),
      unavailable: true,
      canPin: true,
      windows: [],
      closeLauncher: () => {},
      dispatch: () => {},
      pin: () => {},
    });
    const unavailableDesktop = launcherMenuActions({
      app: app(),
      unavailable: false,
      canPin: false,
      windows: [],
      closeLauncher: () => {},
      dispatch: () => {},
      pin: () => {},
    });

    expect(unavailableApp[0]).toMatchObject({
      id: "open",
      label: "Open Notes",
      disabled: true,
    });
    expect(unavailableApp[1]).toMatchObject({ id: "pin", disabled: false });
    expect(unavailableDesktop[0]).toMatchObject({
      id: "open",
      disabled: false,
    });
    expect(unavailableDesktop[1]).toMatchObject({
      id: "pin",
      disabled: true,
    });
  });
});
