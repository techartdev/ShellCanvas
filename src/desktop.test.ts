// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import { defineApps, type DesktopApp } from "./sdk";
import {
  initialDesktop,
  focusedApp,
  updateDesktop,
  type DesktopAction,
  type DesktopState,
} from "./desktop";

const local: DesktopApp = {
  apiVersion: 1,
  id: "community.notes",
  title: "Notes",
  subtitle: "Local notes",
  scope: "local",
  requires: [],
  icon: () => null,
  component: () => null,
};
const apps = defineApps([
  { ...local, id: "remote.one", scope: "host", window: { openOnStart: true } },
  { ...local, id: "remote.two", scope: "host", window: { openOnStart: true } },
  local,
]);
const act = (state: DesktopState, action: DesktopAction) =>
  updateDesktop(state, action, apps);

describe("bundled app contract", () => {
  it("rejects duplicate identities, unsupported versions and unknown capabilities", () => {
    expect(() => defineApps([local, local])).toThrow("duplicate");
    expect(() =>
      defineApps([{ ...local, apiVersion: 2 } as unknown as DesktopApp]),
    ).toThrow("API");
    expect(() =>
      defineApps([
        { ...local, requires: ["shell.admin"] } as unknown as DesktopApp,
      ]),
    ).toThrow("capability");
  });
  it("rejects a local app that requires remote access", () => {
    expect(() => defineApps([{ ...local, requires: ["terminal"] }])).toThrow(
      "Local apps",
    );
  });
  it("supports a new app without built-in IDs or layout settings", () => {
    const state = act(initialDesktop(apps), { type: "open", id: local.id });
    expect(focusedApp(state)).toBe(local.id);
    expect(state.open).toEqual(["remote.one", "remote.two", local.id]);
  });
});

describe("desktop lifecycle", () => {
  it("creates independent instances, restores one, and never reuses closed identities", () => {
    const multiple = defineApps([
      { ...local, window: { multiple: true, openOnStart: true } },
    ]);
    let state = initialDesktop(multiple);
    const update = (action: DesktopAction) => {
      state = updateDesktop(state, action, multiple);
    };
    update({ type: "new", id: local.id });
    const second = focusedApp(state)!;
    expect(second).not.toBe(local.id);
    update({ type: "minimize", id: local.id });
    update({ type: "close", id: second });
    expect(state.open).toEqual([local.id]);
    expect(state.minimized).toContain(local.id);
    update({ type: "open", id: local.id });
    expect(state.minimized).toEqual([]);
    update({ type: "new", id: local.id });
    expect(focusedApp(state)).not.toBe(second);
    expect(Object.keys(state.instances)).toHaveLength(2);
  });
  it("retains minimized instances and restores them from the launcher", () => {
    const state = act(initialDesktop(apps), {
      type: "minimize",
      id: "remote.two",
    });
    expect(state.open).toContain("remote.two");
    expect(focusedApp(state)).toBe("remote.one");
    const restored = act(state, { type: "open", id: "remote.two" });
    expect(restored.minimized).toEqual([]);
    expect(focusedApp(restored)).toBe("remote.two");
  });
  it("removes closed instances and focuses the next visible app", () => {
    const state = act(initialDesktop(apps), {
      type: "close",
      id: "remote.two",
    });
    expect(state.open).toEqual(["remote.one"]);
    expect(focusedApp(state)).toBe("remote.one");
    expect(
      focusedApp(act(state, { type: "close", id: "remote.one" })),
    ).toBeUndefined();
  });
  it("maintains full stacking order across three apps", () => {
    let state = act(initialDesktop(apps), { type: "open", id: local.id });
    state = act(state, { type: "focus", id: "remote.one" });
    expect(state.open).toEqual(["remote.two", local.id, "remote.one"]);
    state = act(state, { type: "close", id: "remote.one" });
    expect(focusedApp(state)).toBe(local.id);
  });
  it("keeps local app state open across a host connection and rejects unknown app IDs", () => {
    const state = act(initialDesktop(apps), { type: "open", id: local.id });
    expect(act(state, { type: "host-connected" }).open).toContain(local.id);
    expect(act(state, { type: "open", id: "missing" })).toBe(state);
  });
});
