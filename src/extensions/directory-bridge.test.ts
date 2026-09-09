// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { AppDirectories } from "./directory-bridge";
import type { AppFileSource } from "./file-bridge";
import type { Directory, DirectoryReader } from "../sdk";
import { RpcPeer, type RpcTransport } from "./rpc";
import { appFileClient } from "../../packages/app-sdk/src/file-client";

function directory(count: number): Directory {
  return {
    path: "opaque:directory",
    name: "Documents",
    parent: "opaque:parent",
    home: { path: "opaque:home", name: "Home" },
    roots: [{ path: "opaque:root", name: "Device" }],
    entries: Array.from({ length: count }, (_, index) => ({
      path: `opaque:item:${index}`,
      name: `file-${index}`,
      kind: "file" as const,
      size: index,
      modified: null,
      revision: `r${index}`,
    })),
  };
}
it("uses provider readers on demand across the public SDK without materializing list", async () => {
  const test = setup(50000);
  let offset = 0;
  const next = vi.fn(async () => {
    const entries = test.data.entries.slice(offset, offset + 128);
    offset += entries.length;
    return {
      directory: { ...test.data, entries },
      done: offset === test.data.entries.length,
    };
  });
  const close = vi.fn(async () => {});
  test.services.openDirectory = vi.fn(async () => ({ next, close }));
  try {
    const iterator = test.api
      .list({ binding: "first" })
      [Symbol.asyncIterator]();
    expect(next).not.toHaveBeenCalled();
    const first = await iterator.next();
    expect(first.value.entries).toHaveLength(128);
    expect(next).toHaveBeenCalledTimes(1);
    await iterator.next();
    expect(next).toHaveBeenCalledTimes(2);
    await iterator.return?.();
    expect(close).toHaveBeenCalledOnce();
    expect(test.services.list).not.toHaveBeenCalled();
    expect(offset).toBe(256);
  } finally {
    test.close();
  }
});
it("splits a provider page by UTF-8 bytes without fetching another page", async () => {
  const test = setup(4);
  test.data.entries.forEach((entry) => {
    entry.name = "🌿".repeat(140000);
  });
  const next = vi.fn(async () => ({ directory: test.data, done: true }));
  test.services.openDirectory = async () => ({ next, close: async () => {} });
  try {
    let count = 0;
    for await (const page of test.api.list({ binding: "first" })) {
      expect(
        new TextEncoder().encode(JSON.stringify(page)).length,
      ).toBeLessThan(1024 * 1024);
      expect(page.entries).toHaveLength(1);
      count += page.entries.length;
    }
    expect(count).toBe(4);
    expect(next).toHaveBeenCalledOnce();
  } finally {
    test.close();
  }
});
it("refuses overlapping reads and closes a late page without retiring a reused identity", async () => {
  const test = setup(257);
  let finish!: (page: { directory: Directory; done: boolean }) => void;
  const close = vi.fn(async () => {});
  const next = vi.fn(async () => ({
    directory: { ...test.data, entries: test.data.entries.slice(0, 128) },
    done: false,
  }));
  next.mockImplementationOnce(async () => ({
    directory: { ...test.data, entries: test.data.entries.slice(0, 128) },
    done: false,
  }));
  next.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  test.services.openDirectory = async () => ({ next, close });
  try {
    await test.methods
      .get("system.files.listStart")!
      .invoke({ id: "same", binding: "first", path: null }, signal());
    const pending = test.methods
      .get("system.files.listNext")!
      .invoke({ id: "same" }, signal());
    expect(() =>
      test.methods
        .get("system.files.listNext")!
        .invoke({ id: "same" }, signal()),
    ).toThrow("already");
    await test.methods
      .get("system.files.listClose")!
      .invoke({ id: "same" }, signal());
    test.services.openDirectory = async () => ({
      next: async () => ({
        directory: { ...test.data, entries: test.data.entries.slice(0, 128) },
        done: false,
      }),
      close: async () => {},
    });
    await test.methods
      .get("system.files.listStart")!
      .invoke({ id: "same", binding: "first", path: null }, signal());
    finish({ directory: { ...test.data, entries: [] }, done: true });
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    expect(close).toHaveBeenCalledOnce();
    await expect(
      test.client.call("system.files.listNext", { id: "same" }),
    ).resolves.toMatchObject({ done: false });
  } finally {
    test.close();
  }
});
it("reports unconfirmed reader cleanup instead of completing the scan", async () => {
  const test = setup(0);
  test.services.openDirectory = async () => ({
    next: async () => ({ directory: test.data, done: true }),
    close: async () => {
      throw new Error("uncertain close");
    },
  });
  try {
    await expect(
      test.api.list({ binding: "first" })[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({
      code: "failed",
      message: "Directory cleanup could not be confirmed.",
    });
  } finally {
    test.close();
  }
});
function setup(count = 257, grants = ["files.read"]) {
  const data = directory(count);
  const services = {
    makeDirectory: vi.fn(),
    renameEntry: vi.fn(),
    moveEntry: vi.fn(),
    removeEntry: vi.fn(),
    list: vi.fn(async () => data),
    openDirectory: undefined as
      | undefined
      | ((path?: string, signal?: AbortSignal) => Promise<DirectoryReader>),
    readText: vi.fn(),
    saveText: vi.fn(),
    createText: vi.fn(),
  };
  let source: AppFileSource | undefined = { binding: "first", services };
  const owner = new AppDirectories(() => source);
  const methods = owner.methods();
  const inputs: ((raw: unknown) => void)[] = [() => {}, () => {}];
  const transports = [0, 1].map((index): RpcTransport => ({
    send: (raw) => queueMicrotask(() => inputs[1 - index](raw)),
    subscribe(receive) {
      inputs[index] = receive;
      return () => {
        inputs[index] = () => {};
      };
    },
    close() {},
  }));
  const server = new RpcPeer(transports[1], methods, grants);
  const client = new RpcPeer(transports[0]);
  server.onClose(() => owner.close());
  return {
    data,
    services,
    owner,
    methods,
    client,
    api: appFileClient(client),
    setSource(next: AppFileSource | undefined) {
      source = next;
    },
    close() {
      client.close();
      server.close();
      owner.close();
    },
  };
}
const signal = () => new AbortController().signal;
it("keeps canceled provider reads charged until their actual completion", async () => {
  const test = setup();
  try {
    const finish: ((value: Directory) => void)[] = [];
    test.services.list.mockImplementation(
      () => new Promise((resolve) => finish.push(resolve)),
    );
    const pending: Promise<unknown>[] = [];
    for (let index = 0; index < 16; index++) {
      const id = `pending-${index}`;
      pending.push(
        Promise.resolve(
          test.methods
            .get("system.files.listStart")!
            .invoke({ id, binding: "first", path: null }, signal()),
        ).catch((error: unknown) => error),
      );
      await test.methods
        .get("system.files.listClose")!
        .invoke({ id }, signal());
    }
    await expect(
      test.client.call("system.files.listStart", {
        id: "overflow",
        binding: "first",
        path: null,
      }),
    ).rejects.toMatchObject({ code: "busy" });
    expect(test.services.list).toHaveBeenCalledTimes(16);
    for (const resolve of finish) resolve(directory(0));
    for (const result of await Promise.all(pending))
      expect(result).toMatchObject({ code: "closed" });
    test.services.list.mockResolvedValue(directory(0));
    expect(
      (await test.api.list({ binding: "first" })[Symbol.asyncIterator]().next())
        .value.entries,
    ).toEqual([]);
  } finally {
    test.close();
  }
});
it("bounds retained listing resources and recovers capacity after close", async () => {
  const test = setup();
  try {
    for (let index = 0; index < 16; index++)
      await test.client.call("system.files.listStart", {
        id: `listing-${index}`,
        binding: "first",
        path: null,
      });
    await expect(
      test.client.call("system.files.listStart", {
        id: "overflow",
        binding: "first",
        path: null,
      }),
    ).rejects.toMatchObject({ code: "busy" });
    await expect(
      test.client.call("system.files.listStart", {
        id: "listing-0",
        binding: "first",
        path: null,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(test.services.list).toHaveBeenCalledTimes(16);
    await test.client.call("system.files.listClose", { id: "listing-0" });
    await test.client.call("system.files.listStart", {
      id: "new",
      binding: "first",
      path: null,
    });
    test.owner.close();
    await expect(
      test.client.call("system.files.listNext", { id: "new" }),
    ).rejects.toMatchObject({ code: "closed" });
    await expect(
      test.client.call("system.files.listStart", {
        id: "closed",
        binding: "first",
        path: null,
      }),
    ).rejects.toMatchObject({ code: "closed" });
  } finally {
    test.close();
  }
});
it("pages 50,000 entries without a count cap, preserves metadata and fetches only once", async () => {
  const test = setup(50000);
  try {
    const paths: string[] = [];
    let pages = 0;
    for await (const page of test.api.list({ binding: "first" })) {
      pages++;
      expect(page.entries.length).toBeLessThanOrEqual(128);
      expect(page).toMatchObject({
        binding: "first",
        path: "opaque:directory",
        parent: "opaque:parent",
        roots: [{ path: "opaque:root", name: "Device" }],
      });
      paths.push(...page.entries.map((entry) => entry.path));
    }
    expect(pages).toBe(391);
    expect(paths).toEqual(test.data.entries.map((entry) => entry.path));
    expect(test.services.list).toHaveBeenCalledExactlyOnceWith(undefined);
  } finally {
    test.close();
  }
});
it("captures a stable listing and yields an empty directory's navigation metadata", async () => {
  const test = setup();
  try {
    const iterator = test.api
      .list({ binding: "first", path: "opaque:directory" })
      [Symbol.asyncIterator]();
    await iterator.next();
    test.data.entries[128].name = "changed afterward";
    expect((await iterator.next()).value.entries[0].name).toBe("file-128");
    await iterator.return?.();
    test.services.list.mockResolvedValueOnce(directory(0));
    const pages = [];
    for await (const page of test.api.list({ binding: "first" }))
      pages.push(page);
    expect(pages).toHaveLength(1);
    expect(pages[0].entries).toEqual([]);
    expect(pages[0].home?.path).toBe("opaque:home");
  } finally {
    test.close();
  }
});
it("releases early-break and paused aborted iterators and keeps repeated scans available", async () => {
  const test = setup();
  try {
    for (let index = 0; index < 40; index++) {
      for await (const page of test.api.list({ binding: "first" })) {
        expect(page.entries).toHaveLength(128);
        break;
      }
    }
    for (let index = 0; index < 20; index++) {
      const controller = new AbortController();
      const iterator = test.api
        .list({ binding: "first" }, controller.signal)
        [Symbol.asyncIterator]();
      await iterator.next();
      controller.abort();
      // Cancellation releases the host slot even while consumer code is paused.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(test.services.list).toHaveBeenCalledTimes(60);
  } finally {
    test.close();
  }
});
it("enforces permissions, owner identity and source retirement without following the new source", async () => {
  const denied = setup(1, []);
  try {
    await expect(
      denied.api.list({ binding: "first" })[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ code: "denied" });
    expect(denied.services.list).not.toHaveBeenCalled();
  } finally {
    denied.close();
  }
  const test = setup();
  try {
    await test.client.call("system.files.listStart", {
      id: "owned",
      binding: "first",
      path: null,
    });
    await expect(
      test.client.call("system.files.listNext", { id: "foreign" }),
    ).rejects.toMatchObject({ code: "closed" });
    test.setSource({ binding: "second", services: test.services });
    await expect(
      test.client.call("system.files.listNext", { id: "owned" }),
    ).rejects.toMatchObject({ code: "closed" });
    await expect(
      test.api.list({ binding: "first" })[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ code: "closed" });
    expect(test.services.list).toHaveBeenCalledTimes(1);
    await test.client.call("system.files.listClose", { id: "owned" });
  } finally {
    test.close();
  }
});
it("closing a pending start prevents resurrection and cannot delete a reused request's listing", async () => {
  const test = setup();
  try {
    let finish!: (value: Directory) => void;
    test.services.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const old = test.methods
      .get("system.files.listStart")!
      .invoke({ id: "same", binding: "first", path: null }, signal());
    await test.methods
      .get("system.files.listClose")!
      .invoke({ id: "same" }, signal());
    await test.methods
      .get("system.files.listStart")!
      .invoke({ id: "same", binding: "first", path: null }, signal());
    finish(directory(300));
    await expect(old).rejects.toMatchObject({ code: "closed" });
    await expect(
      test.client.call("system.files.listNext", { id: "same" }),
    ).resolves.toMatchObject({ done: false });
    test.owner.refresh(false);
    await expect(
      test.client.call("system.files.listNext", { id: "same" }),
    ).rejects.toMatchObject({ code: "closed" });
  } finally {
    test.close();
  }
});
it("pages large names within the wire budget and releases an oversized entry on failure", async () => {
  const test = setup(20);
  try {
    test.data.entries.forEach((entry) => {
      entry.name = "x".repeat(200000);
    });
    let count = 0;
    for await (const page of test.api.list({ binding: "first" })) {
      expect(JSON.stringify(page).length).toBeLessThan(1050000);
      count += page.entries.length;
    }
    expect(count).toBe(20);
    test.data.entries[0].name = "x".repeat(1100000);
    await expect(
      test.api.list({ binding: "first" })[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({ code: "failed" });
    test.services.list.mockResolvedValue(directory(0));
    expect(
      (await test.api.list({ binding: "first" })[Symbol.asyncIterator]().next())
        .value.entries,
    ).toEqual([]);
  } finally {
    test.close();
  }
});
