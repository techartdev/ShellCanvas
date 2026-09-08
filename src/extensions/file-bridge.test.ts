// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { fileMethods, type AppFileSource } from "./file-bridge";
import { RpcPeer, type RpcTransport } from "./rpc";
import { appFileClient } from "../../packages/app-sdk/src/file-client";

const document = {
  path: "opaque:item",
  parent: "opaque:parent",
  name: "note.txt",
  text: "Hello 🌍",
  revision: "r1",
  writable: true,
};
function setup(grants = ["files.read", "files.edit", "files.create"]) {
  const services = {
    makeDirectory: vi.fn(async () => "opaque:created"),
    renameEntry: vi.fn(async () => "opaque:renamed"),
    moveEntry: vi.fn(async () => "opaque:moved"),
    removeEntry: vi.fn(async () => {}),
    list: vi.fn(),
    readText: vi.fn(async () => ({ ...document })),
    saveText: vi.fn(async (_path: string, text: string, _revision: string) => ({
      ...document,
      text,
      revision: "r2",
    })),
    createText: vi.fn(async (_parent: string, _name: string, text: string) => ({
      ...document,
      text,
    })),
  };
  let source: AppFileSource | undefined = { binding: "first", services };
  const inputs: ((raw: unknown) => void)[] = [() => {}, () => {}];
  const transports = [0, 1].map((index): RpcTransport => ({
    send: (raw) => queueMicrotask(() => inputs[1 - index](raw)),
    subscribe: (receive) => {
      inputs[index] = receive;
      return () => {
        inputs[index] = () => {};
      };
    },
    close() {},
  }));
  const methods = fileMethods(() => source);
  const server = new RpcPeer(transports[1], methods, grants);
  const client = new RpcPeer(transports[0]);
  return {
    services,
    methods,
    client,
    api: appFileClient(client),
    setSource: (next: AppFileSource | undefined) => {
      source = next;
    },
    close: () => {
      client.close();
      server.close();
    },
  };
}
it("round trips opaque locations, Unicode and exact reviewed revisions through the public client", async () => {
  const test = setup();
  try {
    const opened = await test.api.readText({
      binding: "first",
      path: document.path,
    });
    expect(opened).toEqual({ ...document, binding: "first" });
    const saved = await test.api.saveText(opened, "Changed ✓");
    expect(test.services.saveText).toHaveBeenCalledWith(
      document.path,
      "Changed ✓",
      "r1",
    );
    expect(saved.revision).toBe("r2");
    expect(opened.revision).toBe("r1");
    await test.api.createText({
      binding: "first",
      parent: document.parent,
      name: "new.txt",
      text: "新",
    });
    expect(test.services.createText).toHaveBeenCalledWith(
      document.parent,
      "new.txt",
      "新",
    );
  } finally {
    test.close();
  }
});
it("routes file actions with exact entry revisions and returns provider-owned destinations", async () => {
  const test = setup(["files.manage", "files.move"]);
  try {
    const entry = {
      binding: "first",
      path: "opaque:item",
      revision: "entry-r1",
    };
    await expect(
      test.api.makeDirectory({
        binding: "first",
        parent: "opaque:parent",
        name: "新しい",
      }),
    ).resolves.toEqual({ binding: "first", path: "opaque:created" });
    expect(test.services.makeDirectory).toHaveBeenCalledExactlyOnceWith(
      "opaque:parent",
      "新しい",
    );
    await expect(test.api.renameEntry(entry, "new.txt")).resolves.toEqual({
      binding: "first",
      path: "opaque:renamed",
    });
    expect(test.services.renameEntry).toHaveBeenCalledExactlyOnceWith(
      entry.path,
      "new.txt",
      "entry-r1",
    );
    await expect(
      test.api.moveEntry(entry, {
        binding: "first",
        path: "opaque:destination",
      }),
    ).resolves.toEqual({ binding: "first", path: "opaque:moved" });
    expect(test.services.moveEntry).toHaveBeenCalledExactlyOnceWith(
      entry.path,
      "opaque:destination",
      "entry-r1",
    );
    await expect(test.api.removeEntry(entry)).resolves.toBeUndefined();
    expect(test.services.removeEntry).toHaveBeenCalledExactlyOnceWith(
      entry.path,
      "entry-r1",
    );
    expect(entry.revision).toBe("entry-r1");
  } finally {
    test.close();
  }
});
it("separates mutation permissions and refuses mixed-source destinations and stale entries", async () => {
  const denied = setup(["files.read", "files.edit", "files.create"]);
  const entry = { binding: "first", path: "opaque:item", revision: "entry-r1" };
  try {
    await expect(
      denied.api.makeDirectory({ binding: "first", parent: "p", name: "n" }),
    ).rejects.toMatchObject({ code: "denied" });
    await expect(denied.api.renameEntry(entry, "n")).rejects.toMatchObject({
      code: "denied",
    });
    await expect(
      denied.api.moveEntry(entry, { binding: "first", path: "p" }),
    ).rejects.toMatchObject({ code: "denied" });
    await expect(denied.api.removeEntry(entry)).rejects.toMatchObject({
      code: "denied",
    });
    expect(denied.services.removeEntry).not.toHaveBeenCalled();
  } finally {
    denied.close();
  }
  const test = setup(["files.manage", "files.move"]);
  try {
    await expect(
      test.api.moveEntry(entry, { binding: "another", path: "p" }),
    ).rejects.toMatchObject({ code: "invalid" });
    test.setSource({ binding: "second", services: test.services });
    await expect(test.api.renameEntry(entry, "n")).rejects.toMatchObject({
      code: "closed",
    });
    await expect(test.api.removeEntry(entry)).rejects.toMatchObject({
      code: "closed",
    });
    await expect(
      test.api.makeDirectory({ binding: "first", parent: "p", name: "n" }),
    ).rejects.toMatchObject({ code: "closed" });
    expect(test.services.moveEntry).not.toHaveBeenCalled();
    expect(test.services.renameEntry).not.toHaveBeenCalled();
    expect(test.services.removeEntry).not.toHaveBeenCalled();
    expect(test.services.makeDirectory).not.toHaveBeenCalled();
  } finally {
    test.close();
  }
});
it("does not retry failed mutations or publish a late destination after source replacement", async () => {
  const test = setup(["files.manage", "files.move"]);
  const entry = { binding: "first", path: "opaque:item", revision: "entry-r1" };
  try {
    test.services.renameEntry.mockRejectedValueOnce(
      new Error("Destination already exists"),
    );
    await expect(test.api.renameEntry(entry, "existing")).rejects.toThrow(
      "Destination already exists",
    );
    expect(test.services.renameEntry).toHaveBeenCalledTimes(1);
    test.services.removeEntry.mockRejectedValueOnce(
      new Error("Entry revision changed"),
    );
    await expect(test.api.removeEntry(entry)).rejects.toThrow(
      "Entry revision changed",
    );
    expect(test.services.removeEntry).toHaveBeenCalledTimes(1);
    let finish!: (path: string) => void;
    test.services.moveEntry.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = test.api.moveEntry(entry, { binding: "first", path: "p" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    test.setSource({ binding: "second", services: test.services });
    finish("opaque:old-result");
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    expect(test.services.moveEntry).toHaveBeenCalledTimes(1);
  } finally {
    test.close();
  }
});
it("enforces read, edit and create grants separately before dispatch", async () => {
  const test = setup(["files.read"]);
  try {
    const opened = await test.api.readText({
      binding: "first",
      path: document.path,
    });
    await expect(test.api.saveText(opened, "denied")).rejects.toMatchObject({
      code: "denied",
    });
    await expect(
      test.api.createText({
        binding: "first",
        parent: "x",
        name: "x",
        text: "x",
      }),
    ).rejects.toMatchObject({ code: "denied" });
    expect(test.services.saveText).not.toHaveBeenCalled();
    expect(test.services.createText).not.toHaveBeenCalled();
    await expect(
      test.client.call("system.files.readText", {
        binding: "first",
        path: "x",
        sessionId: 42,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(test.services.readText).toHaveBeenCalledTimes(1);
  } finally {
    test.close();
  }
});
it("refuses documents and locations from an old binding after explicit source acceptance", async () => {
  const test = setup();
  try {
    const opened = await test.api.readText({
      binding: "first",
      path: document.path,
    });
    test.setSource({ binding: "second", services: test.services });
    await expect(
      test.api.saveText(opened, "must not write"),
    ).rejects.toMatchObject({ code: "closed" });
    await expect(
      test.api.readText({ binding: "first", path: document.path }),
    ).rejects.toMatchObject({ code: "closed" });
    await expect(
      test.api.createText({
        binding: "first",
        parent: "x",
        name: "x",
        text: "x",
      }),
    ).rejects.toMatchObject({ code: "closed" });
    expect(test.services.saveText).not.toHaveBeenCalled();
    expect(test.services.createText).not.toHaveBeenCalled();
  } finally {
    test.close();
  }
});
it("suppresses a late result without dispatching to a replacement source", async () => {
  const test = setup();
  try {
    let finish!: (value: typeof document) => void;
    test.services.readText.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = test.api.readText({
      binding: "first",
      path: document.path,
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    test.setSource({ binding: "second", services: test.services });
    finish(document);
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    expect(test.services.readText).toHaveBeenCalledTimes(1);
  } finally {
    test.close();
  }
});
it("does not retry revision conflicts or pretend cancellation undoes a dispatched write", async () => {
  const test = setup();
  try {
    const opened = { ...document, binding: "first" };
    test.services.saveText.mockRejectedValueOnce(
      new Error("Revision conflict"),
    );
    await expect(test.api.saveText(opened, "new")).rejects.toThrow(
      "Revision conflict",
    );
    expect(test.services.saveText).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    controller.abort();
    await expect(
      test.methods.get("system.files.saveText")!.invoke(
        {
          binding: "first",
          path: document.path,
          revision: "r1",
          text: "new",
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(test.services.saveText).toHaveBeenCalledTimes(1);
    const late = new AbortController();
    test.services.saveText.mockReset().mockImplementationOnce(async () => {
      late.abort();
      return document;
    });
    await expect(
      test.methods.get("system.files.saveText")!.invoke(
        {
          binding: "first",
          path: document.path,
          revision: "r1",
          text: "new",
        },
        late.signal,
      ),
    ).rejects.toMatchObject({
      code: "aborted",
      message: expect.stringContaining("may have completed"),
    });
  } finally {
    test.close();
  }
});
