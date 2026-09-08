// SPDX-License-Identifier: MPL-2.0
import { it, expect, vi } from "vitest";
import { customMethods } from "./custom-bridge";
import { bindSession } from "../session-services";
import { previewServices, previewSession } from "../preview";
import { scopeAppServices } from "../app-services";
import { apps } from "../apps/registry";
const metadata = {
  name: "acme.echo",
  service: "acme",
  version: 2,
  binding: "original",
  available: true,
};
it("checks custom grants before dispatch, preserves binding identity, and rejects forged native handles", async () => {
  const call = vi.fn(async () => ({ ok: true }));
  const access = { list: async () => [metadata], call };
  const denied = customMethods(access, [], () => true);
  expect(await denied.list()).toEqual([
    {
      name: "acme.echo",
      version: 2,
      source: "original",
      permissions: ["services.acme"],
      granted: false,
      available: true,
    },
  ]);
  await expect(
    denied.call.invoke(
      { method: "acme.echo", params: null },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "denied" });
  expect(call).not.toHaveBeenCalled();
  const allowed = customMethods(access, ["services.acme"], () => true);
  const signal = new AbortController().signal;
  await expect(
    allowed.call.invoke({ method: "acme.echo", params: { hello: 1 } }, signal),
  ).resolves.toEqual({ ok: true });
  expect(call).toHaveBeenCalledWith(
    "original",
    "acme.echo",
    { hello: 1 },
    signal,
  );
  await expect(
    allowed.call.invoke({ method: "acme.echo", sessionId: 99 }, signal),
  ).rejects.toMatchObject({ code: "invalid" });
  await expect(
    allowed.call.invoke({ method: "system.private.credentials" }, signal),
  ).rejects.toMatchObject({ code: "unavailable" });
});
it("keeps disconnected discovery usable and refuses late dispatch after connection changes", async () => {
  let connected = true;
  const call = vi.fn(async () => null);
  const list = vi.fn(async () => [metadata]);
  const bridge = customMethods(
    { list, call },
    ["services.acme"],
    () => connected,
  );
  await bridge.list();
  connected = false;
  expect((await bridge.list())[0].available).toBe(false);
  expect(list).toHaveBeenCalledTimes(1);
  await expect(
    bridge.call.invoke({ method: "acme.echo" }, new AbortController().signal),
  ).rejects.toMatchObject({ code: "unavailable" });
  connected = true;
  list.mockImplementationOnce(async () => {
    connected = false;
    return [metadata];
  });
  await expect(
    bridge.call.invoke({ method: "acme.echo" }, new AbortController().signal),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(call).not.toHaveBeenCalled();
});
it("session disposal cancels only its custom calls and scoped apps cannot borrow other grants", async () => {
  let finish: (value: null) => void = () => {};
  let canceled = false;
  const backend = {
    ...previewServices,
    custom: {
      list: async () => [metadata],
      call: vi.fn(
        async (
          _id: number,
          _binding: string,
          _method: string,
          _params: unknown,
          signal?: AbortSignal,
        ) => {
          signal?.addEventListener("abort", () => {
            canceled = true;
          });
          return new Promise<null>((resolve) => {
            finish = resolve;
          });
        },
      ),
    },
  };
  const owner = bindSession(backend, previewSession);
  const other = bindSession(backend, { ...previewSession, id: 77 });
  const scoped = scopeAppServices(owner.services, {
    ...apps[0],
    customPermissions: [],
  });
  const alreadyCanceled = new AbortController();
  alreadyCanceled.abort();
  await expect(
    owner.services.custom!.call(
      "original",
      "acme.echo",
      null,
      alreadyCanceled.signal,
    ),
  ).rejects.toMatchObject({ code: "aborted" });
  expect(backend.custom.call).not.toHaveBeenCalled();
  await expect(
    scoped.custom!.call("original", "acme.echo", null),
  ).rejects.toMatchObject({ code: "denied" });
  const pending = owner.services.custom!.call("original", "acme.echo", null);
  owner.dispose();
  expect(canceled).toBe(true);
  finish(null);
  await expect(pending).rejects.toMatchObject({ code: "closed" });
  expect(await other.services.custom!.list()).toEqual([metadata]);
  other.dispose();
});
