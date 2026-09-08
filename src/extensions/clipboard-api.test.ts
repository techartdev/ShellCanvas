// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { AppClipboard, appClipboardClient } from "./clipboard-api";
import { RpcPeer, messagePortTransport } from "./rpc";
function setup(grants = ["system.clipboard.read", "system.clipboard.write"]) {
  let text = "original";
  const backend = {
    readText: vi.fn(async () => text),
    writeText: vi.fn(async (value: string) => {
      text = value;
    }),
  };
  const owner = new AppClipboard(backend),
    channel = new MessageChannel();
  const host = new RpcPeer(
    messagePortTransport(channel.port1),
    owner.methods(),
    grants,
  );
  host.onClose(() => owner.close());
  const peer = new RpcPeer(messagePortTransport(channel.port2));
  return {
    owner,
    backend,
    peer,
    client: appClipboardClient(peer),
    current: () => text,
    close: () => {
      host.close();
      peer.close();
    },
  };
}
it("streams text larger than one RPC envelope, preserves split surrogate pairs, and handles empty text", async () => {
  const fixture = setup();
  const text = "a".repeat(65535) + "🌿" + "\u0001".repeat(800000);
  expect(JSON.stringify(text).length).toBeGreaterThan(4 * 1024 * 1024);
  await fixture.client.writeText(text);
  expect(fixture.current()).toBe(text);
  expect(await fixture.client.readText()).toBe(text);
  expect(fixture.backend.writeText).toHaveBeenCalledTimes(1);
  await fixture.client.writeText("");
  expect(await fixture.client.readText()).toBe("");
  fixture.close();
});
it("requires distinct read/write grants before touching the native backend", async () => {
  const fixture = setup([]);
  await expect(fixture.client.readText()).rejects.toMatchObject({
    code: "denied",
  });
  await expect(fixture.client.writeText("new")).rejects.toMatchObject({
    code: "denied",
  });
  expect(fixture.backend.readText).not.toHaveBeenCalled();
  expect(fixture.backend.writeText).not.toHaveBeenCalled();
  fixture.close();
});
it("captures a read snapshot and refuses foreign handles, reordering and incomplete commits", async () => {
  const first = setup(),
    second = setup();
  const read = (await first.peer.call("system.clipboard.readStart", {
    id: "read-one",
  })) as { id: string; length: number };
  await first.backend.writeText("changed outside the read");
  await expect(
    second.peer.call("system.clipboard.readChunk", { id: read.id, offset: 0 }),
  ).rejects.toMatchObject({ code: "denied" });
  await expect(
    first.peer.call("system.clipboard.readChunk", { id: read.id, offset: 1 }),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(
    await first.peer.call("system.clipboard.readChunk", {
      id: read.id,
      offset: 0,
    }),
  ).toBe("original");
  const id = (await first.peer.call("system.clipboard.writeStart", {
    id: "write-one",
    length: 4,
  })) as string;
  await expect(
    second.peer.call("system.clipboard.writeChunk", {
      id,
      offset: 0,
      text: "test",
    }),
  ).rejects.toMatchObject({ code: "denied" });
  await expect(
    first.peer.call("system.clipboard.writeCommit", { id }),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(first.current()).toBe("changed outside the read");
  await first.peer.call("system.clipboard.release", { id });
  await first.client.writeText("clean");
  first.close();
  second.close();
});
it("cancels staging without publishing and releases it for the next copy", async () => {
  const fixture = setup(),
    controller = new AbortController();
  const client = appClipboardClient({
    call: async (method, params, signal) => {
      const result = await fixture.peer.call(method, params, signal);
      if (method === "system.clipboard.writeChunk") controller.abort();
      return result;
    },
  });
  await expect(
    client.writeText("partial", controller.signal),
  ).rejects.toMatchObject({ code: "aborted" });
  expect(fixture.backend.writeText).not.toHaveBeenCalled();
  await fixture.client.writeText("next");
  expect(fixture.current()).toBe("next");
  fixture.close();
});
it("drops a late read after owner close and never retries a dispatched write", async () => {
  const fixture = setup();
  let finishRead!: (text: string) => void;
  fixture.backend.readText.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
  );
  const reading = fixture.client.readText();
  const rejected = expect(reading).rejects.toMatchObject({ code: "closed" });
  await vi.waitFor(() => expect(fixture.backend.readText).toHaveBeenCalled());
  fixture.close();
  await rejected;
  finishRead("private text");
  const second = setup();
  let finishWrite!: () => void;
  second.backend.writeText.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishWrite = resolve;
      }),
  );
  const writing = second.client.writeText("already dispatched"),
    stopped = expect(writing).rejects.toMatchObject({ code: "closed" });
  await vi.waitFor(() =>
    expect(second.backend.writeText).toHaveBeenCalledTimes(1),
  );
  second.close();
  await stopped;
  finishWrite();
  expect(second.backend.writeText).toHaveBeenCalledTimes(1);
});
it("releases a canceled start even before its acknowledgement or native read arrives", async () => {
  const fixture = setup(),
    controller = new AbortController();
  let finish!: (value: string) => void;
  fixture.backend.readText.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = fixture.client.readText(controller.signal),
    canceled = expect(pending).rejects.toMatchObject({ code: "aborted" });
  await vi.waitFor(() => expect(fixture.backend.readText).toHaveBeenCalled());
  controller.abort();
  await canceled;
  expect(await fixture.client.readText()).toBe("original");
  finish("late snapshot");
  fixture.close();
});
it("keeps a native clipboard publication exclusive until it completes", async () => {
  const fixture = setup();
  let finish!: () => void;
  fixture.backend.writeText.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = fixture.client.writeText("first");
  await vi.waitFor(() =>
    expect(fixture.backend.writeText).toHaveBeenCalledTimes(1),
  );
  await expect(fixture.client.writeText("overlapping")).rejects.toMatchObject({
    code: "busy",
  });
  finish();
  await pending;
  await fixture.client.writeText("next");
  expect(fixture.current()).toBe("next");
  fixture.close();
});
