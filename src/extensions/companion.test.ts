// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import {
  AppCompanion,
  type CompanionBackend,
  type CompanionHost,
  type CompanionHostGetter,
} from "./companion";
import type { AdapterInfo, AdapterConnectionOptions } from "../adapters";
import type { Session } from "../sdk";
import { RpcPeer, messagePortTransport, type Json } from "./rpc";

function fixture(
  grants = ["services.dev.example.db"],
  host: CompanionHostGetter = () => undefined,
) {
  const pin = {
    id: "dev.example.db",
    version: "1.0.0",
    digest: "a".repeat(64),
  };
  const adapter = {
    ...pin,
    enabled: true,
    revision: "r1",
    name: "DB",
    configuration: [
      { id: "host", kind: "text" },
      { id: "port", kind: "number" },
      { id: "tcpProxyPort", kind: "number" },
    ],
  } as AdapterInfo;
  const session = { id: 17, customSources: {} } as Session;
  const call = vi.fn(async () => ({ rows: [] }));
  const backend = {
    adapters: {
      list: vi.fn(async () => [adapter]),
      connect: vi.fn(
        async (_options: AdapterConnectionOptions, _signal?: AbortSignal) =>
          session,
      ),
    },
    services: () => ({
      list: async () => [
        {
          name: "dev.example.db.query",
          service: "dev.example.db",
          version: 1,
          binding: "native",
          available: true,
        },
      ],
      call,
    }),
    disconnect: vi.fn(async () => {}),
    tunnel: vi.fn(
      async (_source: CompanionHost, _host: string, _port: number) => ({
        port: 51234,
        close: vi.fn(async () => {}),
      }),
    ),
  } satisfies CompanionBackend;
  const owner = new AppCompanion(pin, grants, backend, vi.fn(), host);
  const methods = owner.methods();
  const request = (
    name: string,
    params: Json = null,
    signal = new AbortController().signal,
  ) => methods.get(`system.companion.${name}`)!.invoke(params, signal);
  return { owner, request, backend, adapter, call, session };
}
it("connects only the approved companion and confines calls/cleanup to its own session", async () => {
  const { request, backend, owner, call } = fixture();
  expect(await request("status")).toEqual({ connected: false, binding: null });
  await request("connect", { configuration: { host: "db.example" } });
  expect(backend.adapters.connect.mock.calls[0]?.[0]).toMatchObject({
    sources: [
      {
        id: "dev.example.db",
        revision: "r1",
        configuration: { host: "db.example" },
      },
    ],
    bindings: { "dev.example.db": "companion" },
  });
  await request("call", {
    method: "dev.example.db.query",
    params: { sql: "select 1" },
  });
  expect(call).toHaveBeenCalledWith(
    17,
    "native",
    "dev.example.db.query",
    { sql: "select 1" },
    expect.any(AbortSignal),
  );
  await owner.close();
  await owner.close();
  expect(backend.disconnect).toHaveBeenCalledExactlyOnceWith(17);
  await expect(request("connect", { configuration: {} })).rejects.toMatchObject(
    { code: "closed" },
  );
});
it("rejects missing grants, changed packages, and forged source/configuration fields", async () => {
  const denied = fixture([]);
  await expect(
    denied.request("connect", { configuration: {} }),
  ).rejects.toMatchObject({ code: "denied" });
  const test = fixture();
  await expect(
    test.request("connect", { configuration: {}, sessionId: 5 }),
  ).rejects.toMatchObject({ code: "invalid" });
  await expect(
    test.request("connect", { configuration: { binary: "evil.exe" } }),
  ).rejects.toMatchObject({ code: "invalid" });
  test.adapter.digest = "b".repeat(64);
  await expect(
    test.request("connect", { configuration: {} }),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(test.backend.adapters.connect).not.toHaveBeenCalled();
});
it("closes a connection that finishes after cancellation/window retirement", async () => {
  const test = fixture();
  let finish!: (value: Session) => void;
  test.backend.adapters.connect.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = test.request("connect", { configuration: {} });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await test.owner.close();
  finish(test.session);
  await expect(pending).rejects.toMatchObject({ code: "aborted" });
  expect(test.backend.disconnect).toHaveBeenCalledExactlyOnceWith(17);
});

it("keeps a working connection on failed setup, then closes it after successful replacement", async () => {
  const test = fixture();
  await test.request("connect", { configuration: {} });
  test.backend.adapters.connect.mockRejectedValueOnce(
    new Error("Login failed"),
  );
  await expect(test.request("connect", { configuration: {} })).rejects.toThrow(
    "Login failed",
  );
  expect(await test.request("status")).toMatchObject({ connected: true });
  expect(test.backend.disconnect).not.toHaveBeenCalled();
  test.backend.adapters.connect.mockResolvedValueOnce({
    ...test.session,
    id: 18,
  });
  await test.request("connect", { configuration: {} });
  expect(test.backend.disconnect).toHaveBeenCalledExactlyOnceWith(17);
  await test.owner.close();
  expect(test.backend.disconnect).toHaveBeenLastCalledWith(18);
});

it("preserves native connection errors across the actual app RPC boundary", async () => {
  const test = fixture();
  const channel = new MessageChannel();
  const client = new RpcPeer(messagePortTransport(channel.port1));
  const server = new RpcPeer(
    messagePortTransport(channel.port2),
    test.owner.methods(),
    [],
  );
  try {
    test.backend.adapters.connect.mockRejectedValueOnce(
      "Could not connect to SQL Server",
    );
    await expect(
      client.call("system.companion.connect", { configuration: {} }),
    ).rejects.toMatchObject({
      code: "failed",
      message: "Could not connect to SQL Server",
    });
    test.backend.adapters.connect.mockRejectedValueOnce(
      new Error("SQL Server 18456: Login failed"),
    );
    await expect(
      client.call("system.companion.connect", { configuration: {} }),
    ).rejects.toMatchObject({
      code: "failed",
      message: "SQL Server 18456: Login failed",
    });
    test.backend.adapters.connect.mockRejectedValueOnce({
      internal: "not a public error",
    });
    await expect(
      client.call("system.companion.connect", { configuration: {} }),
    ).rejects.toMatchObject({
      code: "failed",
      message: "The native connector could not establish a connection.",
    });
  } finally {
    client.close();
    server.close();
    await test.owner.close();
  }
});

const remoteConfiguration = { host: "database.remote.test", port: 1433 };
const sshHost: CompanionHost = {
  sessionId: 10,
  source: { instance: 11, generation: 1, adapter: "ssh" },
};
it("requires a separate host grant and never falls back to this PC", async () => {
  const denied = fixture(undefined, () => sshHost);
  await expect(
    denied.request("connect", {
      route: "ssh",
      configuration: remoteConfiguration,
    }),
  ).rejects.toMatchObject({ code: "denied" });
  const missing = fixture(["services.dev.example.db", "host.tcp"]);
  await expect(
    missing.request("connect", {
      route: "ssh",
      configuration: remoteConfiguration,
    }),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(denied.backend.adapters.connect).not.toHaveBeenCalled();
  expect(missing.backend.adapters.connect).not.toHaveBeenCalled();
});
it("pins the accepted SSH source, preserves the TLS hostname, and retires on host replacement", async () => {
  let host: CompanionHost | undefined = sshHost;
  const test = fixture(["services.dev.example.db", "host.tcp"], () => host);
  expect(await test.request("routes")).toEqual({ ssh: true });
  await test.request("connect", {
    route: "ssh",
    configuration: remoteConfiguration,
  });
  expect(test.backend.tunnel).toHaveBeenCalledWith(
    sshHost,
    "database.remote.test",
    1433,
  );
  expect(
    test.backend.adapters.connect.mock.calls[0][0].sources[0].configuration,
  ).toEqual({ ...remoteConfiguration, tcpProxyPort: 51234 });
  const tunnel = await test.backend.tunnel.mock.results[0].value;
  host = { ...sshHost, source: { ...sshHost.source, generation: 2 } };
  await test.owner.refreshHost();
  expect(tunnel.close).toHaveBeenCalledOnce();
  expect(test.backend.disconnect).toHaveBeenCalledExactlyOnceWith(17);
  expect(await test.request("status")).toMatchObject({ connected: false });
});
it("closes late tunnels after cancel and does not launch the connector", async () => {
  const test = fixture(["services.dev.example.db", "host.tcp"], () => sshHost);
  const tunnel = { port: 51234, close: vi.fn(async () => {}) };
  let finish!: (value: typeof tunnel) => void;
  test.backend.tunnel.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const abort = new AbortController();
  const pending = test.request(
    "connect",
    { route: "ssh", configuration: remoteConfiguration },
    abort.signal,
  );
  await vi.waitFor(() => expect(test.backend.tunnel).toHaveBeenCalledOnce());
  abort.abort();
  finish(tunnel);
  await expect(pending).rejects.toMatchObject({ code: "aborted" });
  expect(tunnel.close).toHaveBeenCalledOnce();
  expect(test.backend.adapters.connect).not.toHaveBeenCalled();
});
it("closes a tunnel after database login failure and rejects injected transport fields", async () => {
  const test = fixture(["services.dev.example.db", "host.tcp"], () => sshHost);
  await expect(
    test.request("connect", {
      route: "ssh",
      configuration: { ...remoteConfiguration, tcpProxyPort: 99 },
    }),
  ).rejects.toMatchObject({ code: "invalid" });
  test.backend.adapters.connect.mockRejectedValueOnce("Login failed");
  await expect(
    test.request("connect", {
      route: "ssh",
      configuration: remoteConfiguration,
    }),
  ).rejects.toThrow("Login failed");
  const tunnel = await test.backend.tunnel.mock.results[0].value;
  expect(tunnel.close).toHaveBeenCalledOnce();
});
