// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import {
  AppHostSettings,
  type AppHostSettingsSource,
} from "./host-settings-bridge";
import { RpcPeer, type RpcTransport } from "./rpc";
import {
  appHostSettingsClient,
  type HostSetting,
} from "../../packages/app-sdk/src/host-settings-client";

const original: HostSetting = {
  id: "vendor:timezone",
  label: "Timezone",
  description: "Device clock zone · Часова зона 🌍",
  value: "UTC",
  revision: "r1",
  editor: "select",
  choices: ["UTC", "Europe/Sofia"],
  writable: true,
  reason: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup(grants = ["host.settings.read", "host.settings.write"]) {
  let setting = { ...original };
  const services = {
    readHostSettings: vi.fn(async () => [
      { ...setting, nativeSession: 777 },
      {
        ...original,
        id: "vendor:readonly",
        value: null,
        revision: null,
        writable: false,
        reason: "Unsupported by this device",
      },
    ]),
    applyHostSetting: vi.fn(
      async (id: string, value: string, revision: string) => {
        if (id !== setting.id || revision !== setting.revision)
          throw new Error("Setting revision changed");
        setting = { ...setting, value, revision: "r2" };
        return { ...setting };
      },
    ),
  };
  let source: AppHostSettingsSource | undefined = {
    binding: "first",
    services,
  };
  let available = true;
  const busy = vi.fn();
  const owner = new AppHostSettings(
    () => source,
    () => available,
    busy,
  );
  const inputs: ((raw: unknown) => void)[] = [() => {}, () => {}];
  const transports = [0, 1].map((index): RpcTransport => ({
    send: (raw) => queueMicrotask(() => inputs[1 - index](raw)),
    subscribe(receive) {
      inputs[index] = receive;
      return () => {
        inputs[index] = () => {};
      };
    },
    close() {},
  }));
  const methods = owner.methods();
  const server = new RpcPeer(transports[1], methods, grants);
  const peer = new RpcPeer(transports[0]);
  server.onClose(() => owner.close());
  return {
    api: appHostSettingsClient(peer),
    peer,
    services,
    busy,
    methods,
    owner,
    setSource(next: AppHostSettingsSource | undefined) {
      source = next;
    },
    available(next: boolean) {
      available = next;
    },
    close() {
      peer.close();
      server.close();
      owner.close();
    },
  };
}
it("round trips provider fields and exact revisions without publishing extra native properties", async () => {
  const t = setup();
  try {
    const settings = await t.api.read({ binding: "first" });
    expect(settings[0]).toEqual({ ...original, binding: "first" });
    expect(settings[1]).toMatchObject({
      writable: false,
      value: null,
      revision: null,
      reason: "Unsupported by this device",
    });
    settings[0].choices.push("mutated");
    expect(original.choices).toEqual(["UTC", "Europe/Sofia"]);
    const saved = await t.api.apply(settings[0], "Europe/Sofia");
    expect(t.services.applyHostSetting).toHaveBeenCalledExactlyOnceWith(
      "vendor:timezone",
      "Europe/Sofia",
      "r1",
    );
    expect(saved).toMatchObject({
      value: "Europe/Sofia",
      revision: "r2",
      binding: "first",
    });
    expect(settings[0].revision).toBe("r1");
    await expect(t.api.apply(settings[0], "UTC")).rejects.toMatchObject({
      code: "failed",
      message: "Setting revision changed",
    });
    expect(t.busy.mock.calls.map(([value]) => value)).toEqual([
      true,
      false,
      true,
      false,
    ]);
  } finally {
    t.close();
  }
});
it("enforces independent read and write grants before provider dispatch", async () => {
  for (const grants of [
    [],
    ["host.settings"],
    ["host.settings.read"],
    ["host.settings.write"],
  ]) {
    const t = setup(grants);
    try {
      if (grants.includes("host.settings.read"))
        await t.api.read({ binding: "first" });
      else {
        await expect(t.api.read({ binding: "first" })).rejects.toMatchObject({
          code: "denied",
        });
        expect(t.services.readHostSettings).not.toHaveBeenCalled();
      }
      const change = t.api.apply(
        { ...original, binding: "first" },
        "Europe/Sofia",
      );
      if (grants.includes("host.settings.write")) await change;
      else {
        await expect(change).rejects.toMatchObject({ code: "denied" });
        expect(t.services.applyHostSetting).not.toHaveBeenCalled();
        expect(t.busy).not.toHaveBeenCalled();
      }
    } finally {
      t.close();
    }
  }
});
it("refuses unavailable, foreign and malformed requests before reading or changing settings", async () => {
  const t = setup();
  try {
    await expect(t.api.read({ binding: "other" })).rejects.toMatchObject({
      code: "closed",
    });
    await expect(
      t.api.apply({ ...original, binding: "first", revision: null }, "UTC"),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      t.peer.call("system.hostSettings.apply", {
        binding: "first",
        id: original.id,
        revision: "r1",
        value: "UTC",
        sessionId: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    t.available(false);
    await expect(t.api.read({ binding: "first" })).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(
      t.api.apply({ ...original, binding: "first" }, "UTC"),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(t.services.readHostSettings).not.toHaveBeenCalled();
    expect(t.services.applyHostSetting).not.toHaveBeenCalled();
    expect(t.busy).not.toHaveBeenCalled();
  } finally {
    t.close();
  }
});
it("keeps canceled native reads charged until they settle and lets later reads recover", async () => {
  const t = setup();
  const read =
    deferred<Awaited<ReturnType<typeof t.services.readHostSettings>>>();
  t.services.readHostSettings.mockReturnValueOnce(read.promise);
  try {
    const abort = new AbortController();
    const pending = t.api.read({ binding: "first" }, abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() =>
      expect(t.services.readHostSettings).toHaveBeenCalledOnce(),
    );
    abort.abort();
    await rejected;
    await expect(t.api.read({ binding: "first" })).rejects.toMatchObject({
      code: "busy",
    });
    read.resolve([]);
    await vi.waitFor(async () =>
      expect(await t.api.read({ binding: "first" })).toHaveLength(2),
    );
    expect(t.busy).not.toHaveBeenCalled();
  } finally {
    read.resolve([]);
    t.close();
  }
});
it("protects in-flight updates after client cancellation and never repeats the write", async () => {
  const t = setup();
  const applied = deferred<HostSetting>();
  t.services.applyHostSetting.mockReturnValueOnce(applied.promise);
  try {
    const abort = new AbortController();
    const pending = t.api.apply(
      { ...original, binding: "first" },
      "Europe/Sofia",
      abort.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() =>
      expect(t.services.applyHostSetting).toHaveBeenCalledOnce(),
    );
    abort.abort();
    await rejected;
    expect(t.busy).toHaveBeenLastCalledWith(true);
    await expect(
      t.api.apply({ ...original, binding: "first" }, "UTC"),
    ).rejects.toMatchObject({ code: "busy" });
    applied.resolve({ ...original, value: "Europe/Sofia", revision: "r2" });
    await vi.waitFor(() => expect(t.busy).toHaveBeenLastCalledWith(false));
    expect(t.services.applyHostSetting).toHaveBeenCalledOnce();
  } finally {
    applied.resolve(original);
    t.close();
  }
});
it("rejects late results after source replacement, capability loss or window retirement", async () => {
  for (const retire of ["replace", "unavailable", "close"] as const) {
    const t = setup();
    const pending = deferred<HostSetting>();
    t.services.applyHostSetting.mockReturnValueOnce(pending.promise);
    try {
      const saving = t.api.apply(
        { ...original, binding: "first" },
        "Europe/Sofia",
      );
      const rejected = expect(saving).rejects.toMatchObject({
        code: "closed",
        message: expect.stringContaining("may have been applied"),
      });
      await vi.waitFor(() => expect(t.busy).toHaveBeenLastCalledWith(true));
      if (retire === "replace")
        t.setSource({ binding: "second", services: { ...t.services } });
      if (retire === "unavailable") t.available(false);
      if (retire === "close") t.owner.close();
      pending.resolve(original);
      await rejected;
      expect(t.services.applyHostSetting).toHaveBeenCalledOnce();
      expect(t.busy).toHaveBeenLastCalledWith(false);
    } finally {
      pending.resolve(original);
      t.close();
    }
  }
});
it("does not expose reads completed by a replaced provider and preserves provider failure details", async () => {
  const t = setup();
  const read =
    deferred<Awaited<ReturnType<typeof t.services.readHostSettings>>>();
  t.services.readHostSettings.mockReturnValueOnce(read.promise);
  try {
    const reading = t.api.read({ binding: "first" });
    const rejected = expect(reading).rejects.toMatchObject({ code: "closed" });
    await vi.waitFor(() =>
      expect(t.services.readHostSettings).toHaveBeenCalledOnce(),
    );
    t.setSource({ binding: "second", services: t.services });
    read.resolve([]);
    await rejected;
    t.services.applyHostSetting.mockRejectedValueOnce(
      new Error("Readback failed; outcome uncertain"),
    );
    await expect(
      t.api.apply({ ...original, binding: "second" }, "UTC"),
    ).rejects.toMatchObject({
      code: "failed",
      message: "Readback failed; outcome uncertain",
    });
    expect(t.busy).toHaveBeenLastCalledWith(false);
    expect(t.services.applyHostSetting).toHaveBeenCalledOnce();
  } finally {
    read.resolve([]);
    t.close();
  }
});
