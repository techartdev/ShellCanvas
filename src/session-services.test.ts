// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { bindSession } from "./session-services";
import { previewServices, previewSession } from "./preview";
import type { Directory, TerminalSession } from "./sdk";
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
  resolve({ path: "/a", entries: [] });
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
