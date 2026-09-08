// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import { apps } from "./apps/registry";
import { previewSession } from "./preview";
import {
  connectionProfile,
  initialWorkspaces,
  updateWorkspaces,
} from "./workspaces";
describe("independent workspaces", () => {
  it("reconnects the same endpoint without replacing desktop state or retaining secrets", () => {
    const profile = connectionProfile(
      {
        host: "alpha.example",
        port: 22,
        username: "fixture",
        keyPath: "/key",
        password: "do not retain",
        passphrase: "not retained either",
      },
      "Alpha",
    );
    expect(Object.keys(profile).sort()).toEqual([
      "host",
      "keyPath",
      "name",
      "port",
      "username",
    ]);
    let state = initialWorkspaces(apps, { ...previewSession, id: 8 }, profile);
    state = updateWorkspaces(
      state,
      {
        type: "connected",
        session: { ...previewSession, id: 9 },
        label: "other",
      },
      apps,
    );
    const desktop = state.items[1].desktop,
      other = state.items[2];
    state = updateWorkspaces(state, { type: "lost", sessionId: 8 }, apps);
    const lost = state;
    expect(
      updateWorkspaces(
        state,
        {
          type: "reconnected",
          key: "session-8",
          previousSessionId: 8,
          session: { ...previewSession, id: 10 },
          connection: { ...profile, host: "different.example" },
          label: "wrong",
        },
        apps,
      ),
    ).toBe(lost);
    state = updateWorkspaces(
      state,
      {
        type: "reconnected",
        key: "session-8",
        previousSessionId: 8,
        session: { ...previewSession, id: 10 },
        connection: profile,
        label: "Alpha",
      },
      apps,
    );
    expect(state.items[1].desktop).toBe(desktop);
    expect(state.items[2]).toBe(other);
    expect(state.items[1].session?.id).toBe(10);
    expect(state.items[1].connected).toBe(true);
    expect(state.active).toBe("session-8");
    state = updateWorkspaces(state, { type: "remove", sessionId: 8 }, apps);
    expect(state.items).toHaveLength(3);
    expect(
      updateWorkspaces(
        state,
        {
          type: "connected",
          session: { ...previewSession, id: 10 },
          label: "duplicate",
        },
        apps,
      ),
    ).toBe(state);
  });
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
