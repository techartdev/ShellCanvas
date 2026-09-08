// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import { apps } from "./apps/registry";
import { previewSession } from "./preview";
import { initialWorkspaces, updateWorkspaces } from "./workspaces";
describe("independent workspaces", () => {
  it("retains unsaved instance state after transport loss", () => {
    let state = initialWorkspaces(apps, { ...previewSession, id: 5 });
    state = updateWorkspaces(
      state,
      {
        type: "desktop",
        key: "session-5",
        action: { type: "new", id: "editor", launch: { path: "/draft.txt" } },
      },
      apps,
    );
    state = updateWorkspaces(
      state,
      {
        type: "desktop",
        key: "session-5",
        action: {
          type: "document-state",
          id: "editor",
          dirty: true,
          busy: false,
          title: "draft.txt",
        },
      },
      apps,
    );
    const desktop = state.items.find((w) => w.key === "session-5")!.desktop;
    state = updateWorkspaces(state, { type: "lost", sessionId: 5 }, apps);
    const lost = state.items.find((w) => w.key === "session-5")!;
    expect(lost.connected).toBe(false);
    expect(lost.desktop).toBe(desktop);
    expect(lost.desktop.instances.editor.dirty).toBe(true);
    expect(state.active).toBe("session-5");
  });
  it("preserves app state when switching and only removes the selected session", () => {
    let state = initialWorkspaces(apps, { ...previewSession, id: 1 });
    state = updateWorkspaces(
      state,
      {
        type: "desktop",
        key: "session-1",
        action: { type: "minimize", id: "terminal" },
      },
      apps,
    );
    const first = state.items.find((w) => w.key === "session-1")!;
    state = updateWorkspaces(
      state,
      {
        type: "connected",
        label: "second",
        session: { ...previewSession, id: 2 },
      },
      apps,
    );
    expect(state.items.find((w) => w.key === "session-1")).toBe(first);
    expect(state.active).toBe("session-2");
    state = updateWorkspaces(state, { type: "select", key: "session-1" }, apps);
    expect(
      state.items.find((w) => w.key === state.active)?.desktop.minimized,
    ).toContain("terminal");
    state = updateWorkspaces(state, { type: "remove", sessionId: 1 }, apps);
    expect(state.active).toBe("session-2");
    expect(
      state.items.find((w) => w.key === "session-2")?.desktop.minimized,
    ).toEqual([]);
    state = updateWorkspaces(state, { type: "remove", sessionId: 2 }, apps);
    expect(state.active).toBe("local");
  });
  it("a delayed close for an old generation cannot remove a reconnect", () => {
    let state = initialWorkspaces(apps, { ...previewSession, id: 1 });
    state = updateWorkspaces(state, { type: "remove", sessionId: 1 }, apps);
    state = updateWorkspaces(
      state,
      {
        type: "connected",
        label: "reconnected",
        session: { ...previewSession, id: 3 },
      },
      apps,
    );
    state = updateWorkspaces(state, { type: "remove", sessionId: 1 }, apps);
    expect(state.active).toBe("session-3");
    expect(state.items).toHaveLength(2);
  });
});
