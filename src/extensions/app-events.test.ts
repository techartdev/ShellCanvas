// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { AppEventJournal, appEventClient } from "./app-events";
import { RpcPeer, messagePortTransport, type Json } from "./rpc";
import { discoverMethods } from "./environment";
const signal = () => new AbortController().signal;
const turn = () => new Promise((resolve) => setTimeout(resolve, 10));

it("returns cloned snapshots and explicitly resets readers that fall behind bounded history", async () => {
  const events = new AppEventJournal(["acme.state", "system.environment"], 2);
  const value = { value: 1 };
  events.publish("acme.state", value);
  value.value = 99;
  expect((await events.next(null, signal())).events[0].value).toEqual({
    value: 1,
  });
  for (let value = 2; value < 6; value++)
    events.publish("acme.state", { value });
  events.publish("system.environment", { visible: false });
  const reset = await events.next(1, signal());
  expect(reset.reset).toBe(true);
  expect(reset.events).toHaveLength(2);
  (reset.events[0].value as { value: number }).value = 100;
  expect((await events.next(null, signal())).events[0].value).toEqual({
    value: 5,
  });
  const recent = await events.next(5, signal());
  expect(recent.reset).toBe(false);
  expect(recent.events.map((event) => event.topic)).toEqual([
    "system.environment",
  ]);
  events.close();
});
it("keeps waiters instance-owned, rejects invalid cursors and releases canceled or retired reads", async () => {
  const first = new AppEventJournal(["acme.state"]),
    second = new AppEventJournal(["acme.state"]);
  const controller = new AbortController();
  const pending = first.next(0, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: "aborted" });
  second.publish("acme.state", "other instance");
  await expect(first.next(0, signal())).rejects.toMatchObject({ code: "busy" });
  controller.abort();
  await rejected;
  for (const cursor of [-1, 1, 1.5, Number.NaN])
    await expect(first.next(cursor, signal())).rejects.toMatchObject({
      code: "invalid",
    });
  const again = first.next(0, signal());
  const closed = expect(again).rejects.toMatchObject({ code: "closed" });
  first.close();
  await closed;
  first.close();
  await expect(first.next(null, signal())).rejects.toMatchObject({
    code: "closed",
  });
  second.close();
});
it("fans one real channel stream out to listeners and isolates errors, mutation and unsubscribe", async () => {
  const journal = new AppEventJournal(["acme.state"]);
  journal.publish("acme.state", { version: 1 });
  const channel = new MessageChannel();
  const host = new RpcPeer(
    messagePortTransport(channel.port1),
    new Map([
      [
        "system.events.next",
        {
          grants: [],
          invoke: async (params, signal) =>
            (await journal.next(
              (params as { after: number | null }).after,
              signal,
            )) as unknown as Json,
        },
      ],
    ]),
  );
  host.onClose(() => journal.close());
  const client = new RpcPeer(messagePortTransport(channel.port2));
  const events = appEventClient(client),
    errors = vi.fn(),
    observed: number[] = [];
  const bad = events.subscribe(async () => {
    throw new Error("bad listener");
  }, errors);
  const good = events.subscribe((batch) => {
    for (const event of batch.events)
      observed.push((event.value as { version: number }).version);
  });
  await vi.waitFor(() => expect(observed).toContain(1));
  expect(errors).toHaveBeenCalled();
  bad();
  journal.publish("acme.state", { version: 2 });
  await vi.waitFor(() => expect(observed).toContain(2));
  good();
  journal.publish("acme.state", { version: 3 });
  await turn();
  expect(observed).not.toContain(3);
  let latest = 0;
  const renewed = events.subscribe((batch) => {
    latest = (batch.events.at(-1)!.value as { version: number }).version;
  });
  await vi.waitFor(() => expect(latest).toBe(3));
  renewed();
  client.close();
  host.close();
});
it("discovers arbitrary registered namespaces and enforces live availability without changing handlers", async () => {
  let available = false;
  const invoke = vi.fn(() => "data");
  const methods = new Map([
    [
      "acme.sensor.read",
      { grants: ["acme.sensor"], available: () => available, invoke },
    ],
  ]);
  expect(discoverMethods(methods, [])[0]).toMatchObject({
    name: "acme.sensor.read",
    granted: false,
    available: false,
    version: 1,
  });
  const channel = new MessageChannel(),
    host = new RpcPeer(messagePortTransport(channel.port1), methods, [
      "acme.sensor",
    ]),
    client = new RpcPeer(messagePortTransport(channel.port2));
  await expect(client.call("acme.sensor.read")).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(invoke).not.toHaveBeenCalled();
  available = true;
  expect(discoverMethods(methods, ["acme.sensor"])[0]).toMatchObject({
    granted: true,
    available: true,
  });
  await expect(client.call("acme.sensor.read")).resolves.toBe("data");
  client.close();
  host.close();
});
