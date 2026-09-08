// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { bindSession } from "./session-services";
import { previewServices, previewSession } from "./preview";
import type { Directory, TerminalSession } from "./sdk";
import { watchFileChanges } from "./file-events";
it("moves opaque locations only in the owning capable session, with stale completion reporting", async () => {
  let finish!: (location: string) => void;
  const moveEntry = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const backend = { ...previewServices, moveEntry };
  const incapable = bindSession(backend, {
    ...previewSession,
    info: { ...previewSession.info, capabilities: ["files.manage"] },
  });
  await expect(
    incapable.services.moveEntry("item:1", "folder:2", "rev"),
  ).rejects.toThrow("files.move");
  expect(moveEntry).not.toHaveBeenCalled();
  const session = {
    ...previewSession,
    id: 81,
    info: { ...previewSession.info, capabilities: ["files.move" as const] },
  };
  const binding = bindSession(backend, session);
  const changed = vi.fn(),
    other = vi.fn();
  const stop = watchFileChanges(81, changed),
    stopOther = watchFileChanges(82, other);
  const moved = binding.services.moveEntry("item:1", "folder:2", "rev");
  expect(moveEntry).toHaveBeenCalledWith(81, "item:1", "folder:2", "rev");
  finish("item:3");
  await expect(moved).resolves.toBe("item:3");
  expect(changed).toHaveBeenCalledOnce();
  expect(other).not.toHaveBeenCalled();
  const pending = binding.services.moveEntry("item:4", "folder:2", "rev2");
  binding.dispose();
  finish("item:5");
  await expect(pending).rejects.toThrow("may have completed");
  expect(changed).toHaveBeenCalledOnce();
  await expect(
    binding.services.moveEntry("item:4", "folder:2", "rev2"),
  ).rejects.toThrow("no longer connected");
  expect(moveEntry).toHaveBeenCalledTimes(2);
  stop();
  stopOther();
});
it("scopes host settings, rejects missing capability and rejects stale read/write results", async () => {
  let readDone!: (fields: []) => void;
  const field = {
    id: "vendor.setting",
    label: "Setting",
    description: "Provider-owned",
    value: "old",
    revision: "1",
    editor: "text" as const,
    choices: [],
    writable: true,
    reason: null,
  };
  let writeDone!: (result: typeof field) => void;
  const readHostSettings = vi.fn(
    () => new Promise<[]>((resolve) => (readDone = resolve)),
  );
  const applyHostSetting = vi.fn(
    () => new Promise<typeof field>((resolve) => (writeDone = resolve)),
  );
  const backend = { ...previewServices, readHostSettings, applyHostSetting };
  const unavailable = bindSession(backend, previewSession);
  await expect(unavailable.services.readHostSettings()).rejects.toThrow(
    "Unavailable",
  );
  await expect(
    unavailable.services.applyHostSetting(field.id, "new", "1"),
  ).rejects.toThrow("Unavailable");
  expect(readHostSettings).not.toHaveBeenCalled();
  expect(applyHostSetting).not.toHaveBeenCalled();
  const binding = bindSession(backend, {
    ...previewSession,
    id: 88,
    info: { ...previewSession.info, capabilities: ["host.settings"] },
  });
  const read = binding.services.readHostSettings();
  const write = binding.services.applyHostSetting(field.id, "new", "1");
  expect(readHostSettings).toHaveBeenCalledWith(88);
  expect(applyHostSetting).toHaveBeenCalledWith(88, field.id, "new", "1");
  binding.dispose();
  readDone([]);
  writeDone({ ...field, value: "new", revision: "2" });
  await expect(read).rejects.toThrow("no longer connected");
  await expect(write).rejects.toThrow("may have been applied");
});
it("reports uncertain outcomes when a mutation finishes after session disposal", async () => {
  let resolve!: (value: string) => void;
  const binding = bindSession(
    {
      ...previewServices,
      makeDirectory: () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    },
    {
      ...previewSession,
      id: 20,
      info: { ...previewSession.info, capabilities: ["files.manage"] },
    },
  );
  const changed = vi.fn(),
    stop = watchFileChanges(20, changed);
  const pending = binding.services.makeDirectory("/", "new");
  binding.dispose();
  resolve("/new");
  await expect(pending).rejects.toThrow("may have completed");
  expect(changed).not.toHaveBeenCalled();
  stop();
});
it("scopes file changes and notifications to the owning host and rejects unsupported writes", async () => {
  const makeDirectory = vi.fn(async () => "/created");
  const a = bindSession(
    { ...previewServices, makeDirectory },
    {
      ...previewSession,
      id: 11,
      info: {
        ...previewSession.info,
        capabilities: ["files.read", "files.manage"],
      },
    },
  );
  const changedA = vi.fn(),
    changedB = vi.fn();
  const stopA = watchFileChanges(11, changedA),
    stopB = watchFileChanges(12, changedB);
  expect(await a.services.makeDirectory("/", "created")).toBe("/created");
  expect(makeDirectory).toHaveBeenCalledWith(11, "/", "created");
  expect(changedA).toHaveBeenCalledOnce();
  expect(changedB).not.toHaveBeenCalled();
  const readonly = bindSession(
    { ...previewServices, makeDirectory },
    previewSession,
  );
  await expect(readonly.services.makeDirectory("/", "denied")).rejects.toThrow(
    "Unavailable",
  );
  a.dispose();
  await expect(a.services.makeDirectory("/", "stale")).rejects.toThrow(
    "no longer connected",
  );
  expect(makeDirectory).toHaveBeenCalledOnce();
  stopA();
  stopB();
});
it("routes to the bound session and rejects late results after disposal", async () => {
  let resolve!: (value: Directory) => void;
  const list = vi.fn(
    () =>
      new Promise<Directory>((r) => {
        resolve = r;
      }),
  );
  const a = bindSession(
    { ...previewServices, list },
    { ...previewSession, id: 11 },
  );
  const pending = a.services.list("/a");
  expect(list).toHaveBeenCalledWith(11, "/a");
  a.dispose();
  a.activate(); // React StrictMode can set up the same component again.
  resolve({
    path: "/a",
    name: "a",
    parent: "/",
    home: null,
    roots: [],
    entries: [],
  });
  await expect(pending).rejects.toThrow("no longer connected");
  a.dispose();
  await expect(a.services.list("/b")).rejects.toThrow();
  expect(list).toHaveBeenCalledTimes(1);
  expect("connect" in a.services).toBe(false);
});
it("rejects unsupported service requests before reaching the backend", async () => {
  const list = vi.fn(previewServices.list);
  const binding = bindSession(
    { ...previewServices, list },
    {
      ...previewSession,
      info: { ...previewSession.info, capabilities: ["terminal"] },
    },
  );
  await expect(binding.services.list("/")).rejects.toThrow("Unavailable");
  expect(list).not.toHaveBeenCalled();
});
it("closes late terminals and isolates surviving terminal handles", async () => {
  let resolve!: (handle: TerminalSession) => void;
  const terminal = vi.fn(
    () =>
      new Promise<TerminalSession>((r) => {
        resolve = r;
      }),
  );
  const a = bindSession(
    { ...previewServices, terminal },
    { ...previewSession, id: 1 },
  );
  const pending = a.services.terminal(80, 24, () => {});
  a.dispose();
  const close = vi.fn(async () => {});
  resolve({ close, write: async () => {}, resize: async () => {} });
  await expect(pending).rejects.toThrow("no longer connected");
  expect(close).toHaveBeenCalledOnce();
  const write = vi.fn(async () => {});
  const b = bindSession(
    {
      ...previewServices,
      terminal: async () => ({ close, write, resize: async () => {} }),
    },
    { ...previewSession, id: 2 },
  );
  const handle = await b.services.terminal(80, 24, () => {});
  await handle.write("only b");
  expect(write).toHaveBeenCalledWith("only b");
  b.dispose();
  await expect(handle.write("stale")).rejects.toThrow();
  expect(write).toHaveBeenCalledTimes(1);
});
