// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import {
  defineApps,
  unavailableReason,
  type DesktopApp,
  type SessionServices,
  type Capability,
} from "./sdk";
import { bindSession } from "./session-services";
import { scopeAppServices } from "./app-services";
import { fileClipboard } from "./file-clipboard";
import { previewServices, previewSession } from "./preview";

const manifest = (
  id: string,
  requires: Capability[],
  optional: Capability[] = [],
): DesktopApp =>
  defineApps([
    {
      apiVersion: 1,
      id,
      title: id,
      subtitle: id,
      scope: "host",
      requires,
      optional,
      icon: () => null,
      component: () => null,
    },
  ])[0];
const capableSession = {
  ...previewSession,
  id: 1201,
  info: {
    ...previewSession.info,
    capabilities: [
      "files.read",
      "files.edit",
      "files.create",
      "files.manage",
      "files.move",
      "files.upload",
      "files.download",
      "terminal",
      "host.settings",
    ] as Capability[],
  },
};

it("rejects every undeclared service before invoking a capable host", async () => {
  const calls = new Map<string, ReturnType<typeof vi.fn>>();
  const binding = bindSession(previewServices, capableSession);
  const base = Object.fromEntries(
    Object.keys(binding.services).map((key) => {
      const spy = vi.fn(async () => undefined);
      calls.set(key, spy);
      return [key, spy];
    }),
  ) as unknown as SessionServices;
  const scoped = scopeAppServices(base, manifest("info-only", []));
  const attempts = [
    scoped.list(),
    scoped.preview("file"),
    scoped.readText("file"),
    scoped.saveText("file", "text", "rev"),
    scoped.createText("folder", "name", "text"),
    scoped.makeDirectory("folder", "name"),
    scoped.renameEntry("file", "new", "rev"),
    scoped.removeEntry("file", "rev"),
    scoped.moveEntry("file", "target", "rev"),
    scoped.terminal(80, 24, () => {}),
    scoped.readHostSettings(),
    scoped.applyHostSetting("id", "value", "rev"),
    scoped.chooseUploads("folder"),
    scoped.chooseDownload("file", "rev"),
  ];
  await Promise.all(
    attempts.map((attempt) =>
      expect(attempt).rejects.toThrow("did not declare capability"),
    ),
  );
  await expect(
    scoped.runTransfer(
      { id: 1, name: "file", size: 1, direction: "upload" },
      () => {},
    ),
  ).rejects.toThrow("does not belong");
  await scoped.cancelTransfer(1);
  for (const call of calls.values()) expect(call).not.toHaveBeenCalled();
  binding.dispose();
});

it("allows declared optional services without making them launch requirements", async () => {
  const app = manifest("reader", ["files.read"], ["files.edit"]);
  const list = vi.fn(async () => ({
    path: "node@root",
    name: "Root",
    parent: null,
    home: null,
    roots: [],
    entries: [],
  }));
  const saveText = vi.fn(async () => ({
    path: "node@file",
    name: "File",
    parent: "node@root",
    text: "new",
    revision: "2",
    writable: true,
  }));
  const binding = bindSession(
    { ...previewServices, list, saveText },
    capableSession,
  );
  const scoped = scopeAppServices(binding.services, app);
  expect(scopeAppServices(binding.services, app)).toBe(scoped);
  await expect(scoped.list("node@root")).resolves.toMatchObject({
    path: "node@root",
  });
  await scoped.saveText("node@file", "new", "1");
  expect(saveText).toHaveBeenCalledWith(1201, "node@file", "new", "1");
  const readOnly = {
    ...capableSession,
    info: { ...capableSession.info, capabilities: ["files.read" as const] },
  };
  expect(unavailableReason(app, readOnly)).toBeNull();
  const readonlyBinding = bindSession(
    { ...previewServices, saveText },
    readOnly,
  );
  await expect(
    scopeAppServices(readonlyBinding.services, app).saveText(
      "file",
      "text",
      "rev",
    ),
  ).rejects.toThrow("Unavailable");
  binding.dispose();
  readonlyBinding.dispose();
  await expect(scoped.list()).rejects.toThrow("no longer connected");
});

it("copies declarations and rejects unknown, duplicate and local optional capabilities", () => {
  const optional: Capability[] = ["files.edit"];
  const app = manifest("frozen", ["files.read"], optional);
  optional.push("terminal");
  expect(app.optional).toEqual(["files.edit"]);
  expect(Object.isFrozen(app.optional)).toBe(true);
  expect(Object.isFrozen(app)).toBe(true);
  expect(() => manifest("duplicate", ["files.read"], ["files.read"])).toThrow(
    "Duplicate app capability",
  );
  expect(() => manifest("unknown", [], ["invented" as Capability])).toThrow(
    "Unknown app capability",
  );
  expect(() => defineApps([{ ...app, scope: "local", requires: [] }])).toThrow(
    "Local apps",
  );
});

it("keeps local service handles empty even in a capable workspace", async () => {
  const list = vi.fn();
  const binding = bindSession({ ...previewServices, list }, capableSession);
  const scoped = scopeAppServices(binding.services, {
    ...manifest("local-note", []),
    scope: "local",
  });
  await expect(scoped.list()).rejects.toThrow("did not declare");
  expect(list).not.toHaveBeenCalled();
  binding.dispose();
});

it("owns transfer tickets per app and ignores caller-mutated ticket metadata", async () => {
  const ticket = {
    id: 8,
    name: "upload.bin",
    size: 8,
    direction: "upload" as const,
  };
  const chooseUploads = vi.fn(async () => [ticket]);
  const runTransfer = vi.fn(async () => ({
    status: "completed" as const,
    bytes: 8,
    total: 8,
  }));
  const cancelTransfer = vi.fn(async () => {});
  const binding = bindSession(
    { ...previewServices, chooseUploads, runTransfer, cancelTransfer },
    capableSession,
  );
  const a = scopeAppServices(
    binding.services,
    manifest("uploader-a", [], ["files.upload"]),
  );
  const b = scopeAppServices(
    binding.services,
    manifest("uploader-b", [], ["files.upload"]),
  );
  const downloadOnly = scopeAppServices(
    binding.services,
    manifest("downloader", [], ["files.download"]),
  );
  const [chosen] = await a.chooseUploads("destination");
  chosen.direction = "download";
  chosen.name = "forged";
  await expect(b.runTransfer(chosen, () => {})).rejects.toThrow(
    "does not belong",
  );
  await expect(downloadOnly.runTransfer(chosen, () => {})).rejects.toThrow(
    "does not belong",
  );
  await b.cancelTransfer(chosen.id);
  expect(cancelTransfer).not.toHaveBeenCalled();
  await a.runTransfer(chosen, () => {});
  expect(runTransfer).toHaveBeenCalledWith(
    1201,
    ticket.id,
    expect.any(Function),
  );
  expect(ticket.direction).toBe("upload");
  expect(ticket.name).toBe("upload.bin");
  await a.cancelTransfer(chosen.id);
  expect(cancelTransfer).not.toHaveBeenCalled();
  await expect(a.runTransfer(chosen, () => {})).rejects.toThrow(
    "does not belong",
  );
  binding.dispose();
});

it("shares the workspace file clipboard only with declared move-capable apps", async () => {
  const moveEntry = vi.fn(async () => ({ path: "moved@1", locations: [] }));
  const binding = bindSession(
    { ...previewServices, moveEntry },
    capableSession,
  );
  const first = scopeAppServices(
    binding.services,
    manifest("files-one", ["files.read"], ["files.move"]),
  );
  const second = scopeAppServices(
    binding.services,
    manifest("files-two", ["files.read"], ["files.move"]),
  );
  const readOnly = scopeAppServices(
    binding.services,
    manifest("reader-only", ["files.read"]),
  );
  const entry = {
    path: "node@file",
    name: "File",
    revision: "r1",
    kind: "file" as const,
    size: 1,
    modified: null,
  };
  fileClipboard(first).cut(entry, "node@source");
  expect(fileClipboard(second).snapshot().item?.entry.path).toBe("node@file");
  expect(fileClipboard(readOnly).snapshot().item).toBeNull();
  fileClipboard(readOnly).cut(entry, "node@source");
  await expect(fileClipboard(readOnly).paste("node@target")).rejects.toThrow(
    "did not declare",
  );
  expect(moveEntry).not.toHaveBeenCalled();
  await fileClipboard(second).paste("node@target");
  expect(moveEntry).toHaveBeenCalledOnce();
  fileClipboard(first).cut(entry, "node@source");
  binding.dispose();
  expect(fileClipboard(second).snapshot().item).toBeNull();
});
