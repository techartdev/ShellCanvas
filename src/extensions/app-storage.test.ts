// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { appStorageMethods } from "./app-storage";
import type { AppStorageBackend } from "./storage-api";
import { RpcPeer, messagePortTransport, type Json } from "./rpc";

function setup() {
  const backend: AppStorageBackend = {
    get: vi.fn(async () => null),
    put: vi.fn(async (_owner, _bucket, _key, value) => ({
      value,
      revision: "one",
    })),
    remove: vi.fn(async () => {}),
    list: vi.fn(async () => ({ keys: [], next: null })),
  };
  return {
    backend,
    methods: appStorageMethods("org.example.first", backend),
    signal: new AbortController().signal,
  };
}
it("binds data and settings to the host-owned app identity and keeps the buckets separate", async () => {
  const { backend, methods, signal } = setup();
  await methods
    .get("system.storage.put")!
    .invoke(
      { key: "__proto__", value: { draft: "hello" }, expectedRevision: null },
      signal,
    );
  expect(backend.put).toHaveBeenCalledWith(
    "org.example.first",
    "data",
    "__proto__",
    { draft: "hello" },
    null,
    signal,
  );
  await methods
    .get("system.settings.get")!
    .invoke({ key: "__proto__" }, signal);
  expect(backend.get).toHaveBeenCalledWith(
    "org.example.first",
    "settings",
    "__proto__",
    signal,
  );
  await methods.get("system.storage.list")!.invoke({}, signal);
  expect(backend.list).toHaveBeenCalledWith(
    "org.example.first",
    "data",
    undefined,
    100,
    signal,
  );
  await methods
    .get("system.storage.remove")!
    .invoke({ key: "draft", expectedRevision: "read-version" }, signal);
  expect(backend.remove).toHaveBeenCalledWith(
    "org.example.first",
    "data",
    "draft",
    "read-version",
    signal,
  );
});
it("rejects foreign identities, missing preconditions and unbounded pages before touching storage", async () => {
  const { backend, methods, signal } = setup();
  for (const params of [
    null,
    [],
    { key: "draft", owner: "org.example.other" },
    { key: "" },
    { key: "x".repeat(257) },
  ] as Json[])
    await expect(
      methods.get("system.storage.get")!.invoke(params, signal),
    ).rejects.toMatchObject({ code: "invalid" });
  for (const params of [
    { key: "draft", value: true },
    { key: "draft", expectedRevision: null },
    { key: "draft", value: "x".repeat(1024 * 1024), expectedRevision: null },
  ] as Json[])
    await expect(
      methods.get("system.storage.put")!.invoke(params, signal),
    ).rejects.toMatchObject({ code: "invalid" });
  for (const limit of [0, 201, 2.5, "all", null])
    await expect(
      methods.get("system.storage.list")!.invoke({ limit }, signal),
    ).rejects.toMatchObject({ code: "invalid" });
  expect(backend.get).not.toHaveBeenCalled();
  expect(backend.put).not.toHaveBeenCalled();
  expect(backend.list).not.toHaveBeenCalled();
});
it("checks storage permission on the actual channel and cancels its owned pending work on close", async () => {
  const { backend, methods } = setup();
  for (const grants of [[], ["system.storage"]]) {
    const channel = new MessageChannel();
    const host = new RpcPeer(
      messagePortTransport(channel.port1),
      methods,
      grants,
    );
    const client = new RpcPeer(messagePortTransport(channel.port2));
    if (!grants.length) {
      await expect(
        client.call("system.storage.get", { key: "draft" }),
      ).rejects.toMatchObject({ code: "denied" });
      expect(backend.get).not.toHaveBeenCalled();
    } else {
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let operation: AbortSignal | undefined;
      backend.get = vi.fn((_owner, _bucket, _key, signal) => {
        operation = signal;
        started();
        return new Promise<null>(() => {});
      });
      const pending = client.call("system.storage.get", { key: "draft" });
      const rejected = expect(pending).rejects.toMatchObject({
        code: "closed",
      });
      await ready;
      host.close();
      await rejected;
      expect(operation!.aborted).toBe(true);
    }
    client.close();
    host.close();
  }
});
