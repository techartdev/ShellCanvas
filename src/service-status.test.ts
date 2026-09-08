// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { bindSession } from "./session-services";
import { previewServices, previewSession } from "./preview";
import { apps } from "./apps/registry";
import {
  capabilityStatus,
  unavailableReason,
  type ServiceStatus,
  type Session,
  type TerminalEvent,
} from "./sdk";
import { initialWorkspaces, updateWorkspaces } from "./workspaces";
import type { TransferOutcome } from "./sdk";

const source = { instance: 1, generation: 1, adapter: "fixture-files" };
it("carries custom source changes without rebuilding the desktop and preserves metadata omitted by older backends", () => {
  const initial = {
    ...session("available"),
    customSources: { "acme.sensor": source },
  };
  let state = initialWorkspaces(apps, initial);
  const desktop = state.items[1].desktop;
  const status = { connected: true, services: initial.services! };
  state = updateWorkspaces(
    state,
    { type: "status", sessionId: initial.id, status },
    apps,
  );
  expect(state.items[1].session!.customSources).toEqual(initial.customSources);
  const replacement = { ...source, instance: 55 };
  state = updateWorkspaces(
    state,
    {
      type: "status",
      sessionId: initial.id,
      status: { ...status, customSources: { "acme.sensor": replacement } },
    },
    apps,
  );
  expect(state.items[1].desktop).toBe(desktop);
  expect(state.items[1].session!.customSources).toEqual({
    "acme.sensor": replacement,
  });
  state = updateWorkspaces(
    state,
    {
      type: "status",
      sessionId: initial.id,
      status: { ...status, customSources: {} },
    },
    apps,
  );
  expect(state.items[1].session!.customSources).toEqual({});
});
it("cancels affected transfer tickets and refuses late download confirmation", async () => {
  let finish!: (value: TransferOutcome) => void;
  const cancelTransfer = vi.fn(async () => {});
  const ticket = {
    id: 81,
    name: "file",
    size: 1,
    direction: "download" as const,
  };
  const initial: Session = {
    ...previewSession,
    services: [{ capability: "files.download", state: "available", source }],
  };
  const binding = bindSession(
    {
      ...previewServices,
      cancelTransfer,
      chooseDownload: async () => ticket,
      runTransfer: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
    initial,
  );
  await binding.services.chooseDownload("opaque:file", "rev");
  const pending = binding.services.runTransfer(ticket, () => {});
  binding.updateAvailability({
    ...initial,
    services: [{ capability: "files.download", state: "disconnected", source }],
  });
  expect(cancelTransfer).toHaveBeenCalledWith(initial.id, ticket.id);
  finish({ status: "completed", bytes: 1, total: 1 });
  await expect(pending).rejects.toThrow("Check the local destination");
  binding.dispose();
  expect(cancelTransfer).toHaveBeenCalledOnce();
});
function session(state: ServiceStatus["state"]): Session {
  return {
    ...previewSession,
    services: [
      {
        capability: "files.read",
        state,
        source,
        reason: state === "available" ? null : "File connection unavailable",
      },
      {
        capability: "terminal",
        state: "available",
        source: { ...source, instance: 2, adapter: "fixture-console" },
      },
    ],
  };
}
it("keeps console I/O alive while rejecting stale file results even after availability returns", async () => {
  let finish!: (value: string) => void;
  let event!: (event: TerminalEvent) => void;
  const write = vi.fn(async () => {});
  const onEvent = vi.fn();
  const list = vi.fn(previewServices.list);
  const binding = bindSession(
    {
      ...previewServices,
      list,
      preview: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      terminal: async (_, __, ___, callback) => {
        event = callback;
        return { write, close: async () => {}, resize: async () => {} };
      },
    },
    session("available"),
  );
  const console = await binding.services.terminal(80, 24, onEvent);
  const pending = binding.services.preview("opaque:file");
  binding.updateAvailability(session("disconnected"));
  await expect(binding.services.list()).rejects.toThrow(
    "File connection unavailable",
  );
  expect(list).not.toHaveBeenCalled();
  await console.write("still here");
  event({ type: "output", data: [42] });
  expect(write).toHaveBeenCalledWith("still here");
  expect(onEvent).toHaveBeenCalledOnce();
  binding.updateAvailability(session("available"));
  finish("obsolete response");
  await expect(pending).rejects.toThrow("no longer connected");
  await expect(binding.services.list()).resolves.toBeDefined();
  binding.dispose();
});
it("retains desktop identity and drafts on partial status changes and ignores late polls", () => {
  let state = initialWorkspaces(apps, session("available"));
  const desktop = state.items[1].desktop;
  state = updateWorkspaces(
    state,
    {
      type: "status",
      sessionId: previewSession.id,
      status: { connected: true, services: session("disconnected").services! },
    },
    apps,
  );
  expect(state.items[1].desktop).toBe(desktop);
  expect(state.items[1].connected).toBe(true);
  expect(state.items[1].session!.info.capabilities).toEqual(["terminal"]);
  state = updateWorkspaces(
    state,
    { type: "lost", sessionId: previewSession.id },
    apps,
  );
  expect(
    updateWorkspaces(
      state,
      {
        type: "status",
        sessionId: previewSession.id,
        status: { connected: true, services: session("available").services! },
      },
      apps,
    ),
  ).toBe(state);
});
it("uses explicit reasons for checking, denied and disconnected without blocking independent apps", () => {
  for (const state of [
    "checking",
    "denied",
    "disconnected",
    "unsupported",
  ] as const) {
    expect(
      unavailableReason(
        apps.find((app) => app.id === "files")!,
        session(state),
      ),
    ).toContain("File connection unavailable");
    expect(
      unavailableReason(
        apps.find((app) => app.id === "terminal")!,
        session(state),
      ),
    ).toBeNull();
    expect(capabilityStatus(session(state), "files.edit").state).toBe(
      "unsupported",
    );
  }
});
it("reports uncertain writes after a service changes, without retrying or discarding unrelated handles", async () => {
  let finish!: (
    value: Awaited<ReturnType<typeof previewServices.saveText>>,
  ) => void;
  const saveText = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<typeof previewServices.saveText>>>(
        (resolve) => {
          finish = resolve;
        },
      ),
  );
  const initial: Session = {
    ...session("available"),
    services: [
      ...session("available").services!,
      { capability: "files.edit", state: "available", source },
    ],
  };
  const binding = bindSession({ ...previewServices, saveText }, initial);
  const pending = binding.services.saveText("opaque:file", "draft", "rev1");
  binding.updateAvailability({
    ...initial,
    services: initial.services!.map((item) =>
      item.capability === "files.edit"
        ? { ...item, state: "denied", reason: "Write access revoked" }
        : item,
    ),
  });
  finish({
    path: "opaque:file",
    name: "file",
    parent: null,
    text: "draft",
    revision: "rev2",
    writable: true,
  });
  await expect(pending).rejects.toThrow("may have completed");
  expect(saveText).toHaveBeenCalledOnce();
  await expect(
    binding.services.saveText("opaque:file", "draft", "rev1"),
  ).rejects.toThrow("Write access revoked");
  binding.dispose();
});
