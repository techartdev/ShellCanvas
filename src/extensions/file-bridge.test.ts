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
