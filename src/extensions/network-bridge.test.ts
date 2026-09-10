// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { AppNetwork, type NetworkBackend } from "./network-bridge";
import { RpcPeer, messagePortTransport } from "./rpc";
import { appNetworkClient } from "../../packages/app-sdk/src/network-client";
function fixture(grants = ["system.network"]) {
  const backend: NetworkBackend = {
    available: () => true,
    profile: vi.fn(async () => ({
      endpoint: "https://api.test/chat",
      revision: "r1",
      hasKey: true,
      remembered: true,
    })),
    forget: vi.fn(async () => {}),
    prepare: vi.fn(async () => "native-id"),
    start: vi.fn(async () => ({
      status: 200,
      contentType: "text/event-stream",
    })),
    read: vi
      .fn()
      .mockResolvedValueOnce(
        Array.from(new TextEncoder().encode("data: hello\n\n")),
      )
      .mockResolvedValue(null),
    close: vi.fn(async () => {}),
  };
  const configure = vi.fn(async () => null);
  const owner = new AppNetwork(
    "org.example.app",
    "Test app",
    configure,
    backend,
  );
  const channel = new MessageChannel();
  const server = new RpcPeer(
    messagePortTransport(channel.port1),
    owner.methods(),
    grants,
  );
  const peer = new RpcPeer(messagePortTransport(channel.port2));
  const client = appNetworkClient(peer);
  return {
    owner,
    backend,
    configure,
    peer,
    client,
    close: () => {
      owner.close();
      server.close();
      peer.close();
    },
  };
}
it("checks permission before prompting, loading credentials or sending network traffic", async () => {
  const f = fixture([]);
  try {
    await expect(f.client.profile("model")).rejects.toMatchObject({
      code: "denied",
    });
    await expect(f.client.configure({ slot: "model" })).rejects.toMatchObject({
      code: "denied",
    });
    await expect(
      f.client.postJSON({ slot: "model", revision: "r1", body: {} }),
    ).rejects.toMatchObject({ code: "denied" });
    expect(f.backend.prepare).not.toHaveBeenCalled();
    expect(f.configure).not.toHaveBeenCalled();
    expect(f.backend.profile).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
it("uses host-owned app identity, streams bytes and closes at EOF", async () => {
  const f = fixture();
  try {
    const result = await f.client.postJSON({
      slot: "model",
      revision: "r1",
      body: { message: "hello" },
    });
    expect(new TextDecoder().decode((await result.read())!)).toBe(
      "data: hello\n\n",
    );
    expect(await result.read()).toBeNull();
    expect(f.backend.start).toHaveBeenCalledWith(
      expect.any(String),
      "native-id",
      "org.example.app",
      "model",
      "r1",
      '{"message":"hello"}',
    );
    expect(f.backend.close).toHaveBeenCalledTimes(1);
    await expect(
      f.peer.call("system.network.profile", {
        slot: "model",
        app: "org.other.app",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
  } finally {
    f.close();
  }
});
it("cancels an opening even if native preparation finishes after cancellation", async () => {
  const f = fixture();
  let ready!: () => void;
  f.backend.prepare = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        ready = () => resolve("late-id");
      }),
  );
  try {
    const controller = new AbortController();
    const opening = f.client.postJSON(
      { slot: "model", revision: "r1", body: {} },
      controller.signal,
    );
    const rejected = expect(opening).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() => expect(f.backend.prepare).toHaveBeenCalled());
    controller.abort();
    await rejected;
    await f.client.profile("model"); // Ordered-channel barrier: the host has received cancel/close.
    ready();
    await vi.waitFor(() =>
      expect(f.backend.close).toHaveBeenCalledWith(
        expect.any(String),
        "late-id",
      ),
    );
    expect(f.backend.start).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
it("bounds app chunks and releases requests when the window closes", async () => {
  const f = fixture();
  f.backend.read = vi.fn(async () => new Array(70000).fill(42));
  try {
    const result = await f.client.postJSON({
      slot: "model",
      revision: "r1",
      body: {},
    });
    expect((await result.read())?.length).toBe(32768);
    expect((await result.read())?.length).toBe(32768);
    expect((await result.read())?.length).toBe(4464);
    expect(f.backend.read).toHaveBeenCalledTimes(1);
    f.owner.close();
    await vi.waitFor(() => expect(f.backend.close).toHaveBeenCalledTimes(1));
  } finally {
    f.close();
  }
});
