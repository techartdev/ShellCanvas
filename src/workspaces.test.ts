// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import { apps } from "./apps/registry";
import { previewSession } from "./preview";
import { initialWorkspaces, updateWorkspaces } from "./workspaces";
describe("independent workspaces", () => {
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
