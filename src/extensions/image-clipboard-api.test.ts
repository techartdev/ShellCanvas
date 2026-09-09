// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { AppClipboard, appClipboardClient } from "./clipboard-api";
import { RpcPeer, messagePortTransport } from "./rpc";
import type { ClipboardImage } from "../../packages/app-sdk/src/clipboard-image";
const image = (width = 512, height = 1025): ClipboardImage => ({
  width,
  height,
  rgba: Uint8Array.from({ length: width * height * 4 }, (_, i) => i % 256),
});
function setup(
  grants = ["system.clipboard.image.read", "system.clipboard.image.write"],
) {
  let value = image(2, 1);
  const backend = {
    readText: async () => "text",
    writeText: vi.fn(async () => {}),
    readImage: vi.fn(async () => value),
    writeImage: vi.fn(async (next: ClipboardImage) => {
      value = next;
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
    backend,
    owner,
    peer,
    client: appClipboardClient(peer),
    current: () => value,
    close: () => {
      host.close();
      peer.close();
    },
  };
}
it("streams images beyond an RPC envelope and snapshots caller bytes before awaiting", async () => {
  const f = setup();
  try {
    const expected = image(),
      input = { ...expected, rgba: expected.rgba.slice() };
    expect(JSON.stringify(Array.from(expected.rgba)).length).toBeGreaterThan(
      4 * 1024 * 1024,
    );
    const write = f.client.writeImage(input);
    input.rgba.fill(0);
    input.width = 1;
    await write;
    expect(f.backend.writeImage).toHaveBeenCalledTimes(1);
    expect([f.current().width, f.current().height]).toEqual([
      expected.width,
      expected.height,
    ]);
    expect(
      f.current().rgba.length === expected.rgba.length &&
        f.current().rgba.every((byte, index) => byte === expected.rgba[index]),
    ).toBe(true);
    const read = await f.client.readImage();
    expect([read.width, read.height]).toEqual([
      expected.width,
      expected.height,
    ]);
    expect(
      read.rgba.length === expected.rgba.length &&
        read.rgba.every((byte, index) => byte === expected.rgba[index]),
    ).toBe(true);
    expect(f.backend.writeText).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
it("text permissions cannot read or replace images; missing backend methods are unavailable", async () => {
  const f = setup(["system.clipboard.read", "system.clipboard.write"]);
  try {
    await expect(f.client.readImage()).rejects.toMatchObject({
      code: "denied",
    });
    await expect(f.client.writeImage(image(1, 1))).rejects.toMatchObject({
      code: "denied",
    });
    expect(f.backend.readImage).not.toHaveBeenCalled();
    expect(f.backend.writeImage).not.toHaveBeenCalled();
    const textOnly = new AppClipboard({
      readText: async () => "",
      writeText: async () => {},
    });
    expect(
      textOnly.methods().get("system.clipboard.image.readStart")!.available!(),
    ).toBe(false);
    expect(
      textOnly.methods().get("system.clipboard.image.writeStart")!.available!(),
    ).toBe(false);
    textOnly.close();
  } finally {
    f.close();
  }
});
it("enforces image dimensions, exact ordering, complete publication and window ownership", async () => {
  const f = setup(),
    foreign = setup();
  try {
    await expect(
      f.client.writeImage({ ...image(1, 1), rgba: new Uint8Array(3) }),
    ).rejects.toMatchObject({ code: "invalid" });
    for (const [width, height] of [
      [0, 1],
      [-1, 1],
      [1.5, 1],
      [0xffffffff, 0xffffffff],
    ])
      await expect(
        f.peer.call("system.clipboard.image.writeStart", {
          id: "bad",
          width,
          height,
        }),
      ).rejects.toMatchObject({ code: "invalid" });
    await f.peer.call("system.clipboard.image.writeStart", {
      id: "w",
      width: 1,
      height: 1,
    });
    await expect(
      foreign.peer.call("system.clipboard.image.writeChunk", {
        id: "w",
        offset: 0,
        bytes: [1],
      }),
    ).rejects.toMatchObject({ code: "denied" });
    await expect(
      f.peer.call("system.clipboard.image.writeCommit", { id: "w" }),
    ).rejects.toMatchObject({ code: "invalid" });
    for (const bytes of [[-1], [256], [1.5], [], [1, 2, 3, 4, 5]])
      await expect(
        f.peer.call("system.clipboard.image.writeChunk", {
          id: "w",
          offset: 0,
          bytes,
        }),
      ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      f.peer.call("system.clipboard.image.writeChunk", {
        id: "w",
        offset: 1,
        bytes: [1],
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(f.backend.writeImage).not.toHaveBeenCalled();
    await f.peer.call("system.clipboard.image.writeChunk", {
      id: "w",
      offset: 0,
      bytes: [1, 2, 3, 4],
    });
    await f.peer.call("system.clipboard.image.writeCommit", { id: "w" });
    await expect(
      f.peer.call("system.clipboard.image.writeCommit", { id: "w" }),
    ).rejects.toMatchObject({ code: "denied" });
    expect(f.backend.writeImage).toHaveBeenCalledTimes(1);
  } finally {
    f.close();
    foreign.close();
  }
});
it("captures immutable reads and cannot release another window's snapshot", async () => {
  const f = setup(),
    other = setup();
  try {
    const expected = f.current().rgba.slice();
    await f.peer.call("system.clipboard.image.readStart", { id: "r" });
    f.current().rgba.fill(99);
    await other.peer.call("system.clipboard.image.release", { id: "r" });
    await expect(
      other.peer.call("system.clipboard.image.readChunk", {
        id: "r",
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: "denied" });
    await expect(
      f.peer.call("system.clipboard.image.readChunk", { id: "r", offset: 1 }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(
      await f.peer.call("system.clipboard.image.readChunk", {
        id: "r",
        offset: 0,
      }),
    ).toEqual(Array.from(expected));
    await expect(
      f.peer.call("system.clipboard.image.readChunk", {
        id: "r",
        offset: expected.length,
      }),
    ).rejects.toMatchObject({ code: "denied" });
  } finally {
    f.close();
    other.close();
  }
});
it("holds read capacity until a canceled backend settles, then discards the late snapshot", async () => {
  const f = setup();
  let finish!: (value: ClipboardImage) => void;
  f.backend.readImage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    const abort = new AbortController();
    const reading = f.client
      .readImage(abort.signal)
      .catch((error) => error.code);
    await vi.waitFor(() =>
      expect(f.backend.readImage).toHaveBeenCalledTimes(1),
    );
    abort.abort();
    expect(await reading).toBe("aborted");
    await expect(f.client.readImage()).rejects.toMatchObject({ code: "busy" });
    finish(image(1, 1));
    await vi.waitFor(async () =>
      expect(await f.client.readImage()).toEqual(f.current()),
    );
  } finally {
    finish?.(image(1, 1));
    f.close();
  }
});
it("keeps publication capacity after cancellation and never retries an uncertain write", async () => {
  const f = setup();
  let finish!: () => void;
  f.backend.writeImage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    const abort = new AbortController();
    const writing = f.client
      .writeImage(image(1, 1), abort.signal)
      .catch((error) => error.code);
    await vi.waitFor(() =>
      expect(f.backend.writeImage).toHaveBeenCalledTimes(1),
    );
    abort.abort();
    expect(await writing).toBe("aborted");
    await expect(f.client.writeImage(image(1, 1))).rejects.toMatchObject({
      code: "busy",
    });
    finish();
    f.backend.writeImage.mockRejectedValueOnce(new Error("uncertain"));
    await vi.waitFor(async () => {
      await expect(f.client.writeImage(image(1, 1))).rejects.toMatchObject({
        code: "failed",
      });
    });
    expect(f.backend.writeImage).toHaveBeenCalledTimes(2);
    await f.client.writeImage(image(1, 1));
    expect(f.backend.writeImage).toHaveBeenCalledTimes(3);
  } finally {
    finish?.();
    f.close();
  }
});
