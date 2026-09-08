// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it, vi } from "vitest";
import {
  RpcError,
  RpcPeer,
  type Json,
  type RpcMethod,
  type RpcTransport,
} from "./rpc";

function pair() {
  const inputs: ((message: unknown) => void)[] = [() => {}, () => {}];
  const stops: (() => void)[] = [() => {}, () => {}];
  const transports = [0, 1].map((index): RpcTransport => ({
    send: (message) => queueMicrotask(() => inputs[1 - index](message)),
    subscribe(receive, stop) {
      inputs[index] = receive;
      stops[index] = stop;
      return () => {
        inputs[index] = () => {};
      };
    },
    close: vi.fn(),
  }));
  return {
    transports,
    inject: (raw: unknown) => inputs[1](raw),
    disconnect: () => stops[0](),
  };
}
function setup(methods: [string, RpcMethod][], grants: string[] = []) {
  const channel = pair();
  const client = new RpcPeer(channel.transports[0]);
  const server = new RpcPeer(channel.transports[1], new Map(methods), grants);
  return { ...channel, client, server };
}
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred() {
  let resolve!: (value: Json) => void;
  const promise = new Promise<Json>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe("instance-owned extension RPC", () => {
  it("brokers custom namespaced services and enforces snapshotted grants before dispatch", async () => {
    const invoke = vi.fn((params: Json) => params);
    const grants: string[] = [];
    const declared = ["acme.router.read"];
    const { client, server } = setup(
      [["acme.router.status", { grants: declared, invoke }]],
      grants,
    );
    grants.push("acme.router.read");
    declared.length = 0;
    await expect(client.call("acme.router.status", {})).rejects.toMatchObject({
      code: "denied",
    });
    expect(invoke).not.toHaveBeenCalled();
    await expect(client.call("acme.router.unknown")).rejects.toMatchObject({
      code: "unavailable",
    });
    client.close();
    server.close();
    const allowed = setup(
      [["acme.router.status", { grants: ["acme.router.read"], invoke }]],
      ["acme.router.read"],
    );
    await expect(
      allowed.client.call("acme.router.status", { ports: [1, 2] }),
    ).resolves.toEqual({ ports: [1, 2] });
    allowed.client.close();
  });

  it("isolates instances and correlates out-of-order results", async () => {
    const first = deferred();
    const one = setup([
      [
        "sample.read",
        {
          grants: [],
          invoke: (value) => (value === 1 ? first.promise : "second"),
        },
      ],
    ]);
    const two = setup([
      ["sample.read", { grants: [], invoke: () => "other host" }],
    ]);
    const pending = one.client.call("sample.read", 1);
    await expect(one.client.call("sample.read", 2)).resolves.toBe("second");
    await expect(two.client.call("sample.read", 1)).resolves.toBe("other host");
    first.resolve("first");
    await expect(pending).resolves.toBe("first");
    one.client.close();
    await expect(two.client.call("sample.read")).resolves.toBe("other host");
    two.client.close();
  });

  it("cancels a call, passes an abort signal and discards its late result", async () => {
    const work = deferred();
    let signal!: AbortSignal;
    const { client, server } = setup([
      [
        "sample.read",
        {
          grants: [],
          invoke: (_, control) => {
            signal = control;
            return work.promise;
          },
        },
      ],
    ]);
    const control = new AbortController();
    const pending = client.call("sample.read", null, control.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "aborted" });
    await turn();
    control.abort();
    await rejected;
    await turn();
    expect(signal.aborted).toBe(true);
    work.resolve("old result");
    await turn();
    expect(client.isClosed).toBe(false);
    server.close();
  });

  it("retirement aborts running handlers and rejects all requests without rerouting", async () => {
    const work = deferred();
    let signal!: AbortSignal;
    const old = setup([
      [
        "sample.write",
        {
          grants: [],
          invoke: (_, control) => {
            signal = control;
            return work.promise;
          },
        },
      ],
    ]);
    const replacement = setup([
      ["sample.write", { grants: [], invoke: () => "new generation" }],
    ]);
    const pending = old.client.call("sample.write");
    const rejected = expect(pending).rejects.toMatchObject({ code: "closed" });
    await turn();
    old.server.close();
    await rejected;
    expect(signal.aborted).toBe(true);
    work.resolve("late write result");
    await expect(old.client.call("sample.write")).rejects.toMatchObject({
      code: "closed",
    });
    await expect(replacement.client.call("sample.write")).resolves.toBe(
      "new generation",
    );
    replacement.client.close();
  });

  it("rejects malformed input and replay before a handler can be called twice", async () => {
    const invoke = vi.fn(() => null);
    const replay = setup([["sample.write", { grants: [], invoke }]]);
    const message = JSON.stringify({
      v: 1,
      type: "request",
      id: 1,
      method: "sample.write",
      params: null,
    });
    replay.inject(message);
    replay.inject(message);
    expect(replay.server.isClosed).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    for (const raw of [
      "{",
      {},
      "null",
      '{"v":2,"type":"close"}',
      '{"v":1,"type":"request","id":1,"method":"sample.write"}',
      '{"v":1,"type":"result","id":-1,"value":null}',
    ]) {
      const fixture = setup([["sample.write", { grants: [], invoke }]]);
      fixture.inject(raw);
      expect(fixture.server.isClosed).toBe(true);
    }
    expect(invoke).toHaveBeenCalledTimes(1);
    await turn();
  });

  it("limits in-flight work and closes pending calls when transport disconnects", async () => {
    const work = deferred();
    const fixture = setup([
      ["sample.wait", { grants: [], invoke: () => work.promise }],
    ]);
    const pending = Array.from({ length: 64 }, () =>
      fixture.client.call("sample.wait").catch((error: RpcError) => error.code),
    );
    await expect(fixture.client.call("sample.wait")).rejects.toMatchObject({
      code: "busy",
    });
    fixture.disconnect();
    expect(await Promise.all(pending)).toEqual(Array(64).fill("closed"));
    fixture.server.close();
    work.resolve(null);
  });

  it("reports structured errors, hides arbitrary exception details and rejects non-JSON values", async () => {
    const fixture = setup([
      [
        "sample.secret",
        {
          grants: [],
          invoke: () => {
            throw new Error("private credential");
          },
        },
      ],
      ["sample.invalid", { grants: [], invoke: () => NaN }],
      [
        "sample.conflict",
        {
          grants: [],
          invoke: () => {
            throw new RpcError("unavailable", "Device disconnected.");
          },
        },
      ],
    ]);
    await expect(fixture.client.call("sample.secret")).rejects.toMatchObject({
      code: "failed",
      message: "Service operation failed.",
    });
    await expect(fixture.client.call("sample.invalid")).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(fixture.client.call("sample.conflict")).rejects.toMatchObject({
      code: "unavailable",
      message: "Device disconnected.",
    });
    await expect(
      fixture.client.call("sample.invalid", Infinity),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(fixture.client.isClosed).toBe(false);
    fixture.client.close();
  });
});
