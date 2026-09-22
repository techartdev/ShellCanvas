// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { AppCompanion, type CompanionBackend } from "./companion";
import type { AdapterInfo, AdapterConnectionOptions } from "../adapters";
import type { Session } from "../sdk";
import type { Json } from "./rpc";

function fixture(grants = ["services.dev.example.db"]) {
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
    configuration: [{ id: "host", kind: "text" }],
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
  } satisfies CompanionBackend;
  const owner = new AppCompanion(pin, grants, backend, vi.fn());
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
  test.backend.adapters.connect.mockRejectedValueOnce(new Error("Login failed"));
  await expect(test.request("connect", { configuration: {} })).rejects.toThrow("Login failed");
  expect(await test.request("status")).toMatchObject({ connected: true });
  expect(test.backend.disconnect).not.toHaveBeenCalled();
  test.backend.adapters.connect.mockResolvedValueOnce({ ...test.session, id: 18 });
  await test.request("connect", { configuration: {} });
  expect(test.backend.disconnect).toHaveBeenCalledExactlyOnceWith(17);
  await test.owner.close();
  expect(test.backend.disconnect).toHaveBeenLastCalledWith(18);
});
