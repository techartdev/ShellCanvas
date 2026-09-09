// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  isTauri: () => false,
  Channel: class {
    onmessage: unknown;
  },
}));
import {
  adapterProfile,
  restoredConfiguration,
  nativeAdapterServices,
  type AdapterInfo,
} from "./adapters";
import { sameEndpoint } from "./workspaces";
const installed: AdapterInfo = {
  id: "dev.example.connector",
  name: "Example",
  version: "1.0.0",
  revision: "one",
  generation: "one",
  description: "",
  platform: "windows-x86_64",
  entrypoint: "adapter.exe",
  enabled: true,
  fileCount: 1,
  bytes: 1,
  configuration: [
    { id: "device", label: "Device", kind: "text", required: true },
    { id: "token", label: "Token", kind: "password", required: true },
  ],
};
const options = {
  name: "Device",
  sources: [
    {
      key: "files",
      id: installed.id,
      revision: "one",
      configuration: { device: "opaque://one", token: "secret" },
    },
  ],
  bindings: { files: "files" },
};
it("reviews only selected SSH endpoints and ignores challenges after connection completion", async () => {
  let finish!: (value: unknown) => void;
  invoke.mockReset().mockImplementation((method: string) => {
    if (method === "begin_connect") return Promise.resolve(31);
    if (method === "connect_adapters")
      return new Promise((resolve) => {
        finish = resolve;
      });
    return Promise.resolve();
  });
  const review = vi.fn().mockResolvedValue(true);
  const connecting = nativeAdapterServices.connect(
    {
      ...options,
      sources: [
        {
          key: "ssh",
          id: "builtin:ssh",
          revision: "builtin-1",
          configuration: { host: "device", port: 22, username: "root" },
        },
      ],
      bindings: { console: "ssh" },
    },
    undefined,
    review,
  );
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const args = invoke.mock.calls.find(
    ([method]) => method === "connect_adapters",
  )![1];
  const challenge = {
    host: "device",
    port: 22,
    algorithm: "ed25519",
    fingerprint: "fixture",
    token: "review",
  };
  args.onHostKey.onmessage(challenge);
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("decide_host_key", {
      requestId: 31,
      token: "review",
      approve: true,
    }),
  );
  finish({ id: 100 });
  await connecting;
  args.onHostKey.onmessage({ ...challenge, token: "late" });
  await Promise.resolve();
  expect(review).toHaveBeenCalledTimes(1);
});
it("cancels mismatched SSH challenges before asking for approval", async () => {
  let reject!: (error: Error) => void;
  invoke.mockReset().mockImplementation((method: string) => {
    if (method === "begin_connect") return Promise.resolve(32);
    if (method === "connect_adapters")
      return new Promise((_, fail) => {
        reject = fail;
      });
    if (method === "cancel_connect") reject?.(new Error("Canceled"));
    return Promise.resolve();
  });
  const review = vi.fn().mockResolvedValue(true);
  const connecting = nativeAdapterServices.connect(options, undefined, review);
  const rejected = expect(connecting).rejects.toThrow(/does not match/);
  await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
  invoke.mock.calls
    .find(([method]) => method === "connect_adapters")![1]
    .onHostKey.onmessage({ host: "foreign", port: 22, token: "wrong" });
  await rejected;
  expect(review).not.toHaveBeenCalled();
});
it("restores only currently declared public fields and never prefills reclassified passwords", () => {
  const source = {
    ...options.sources[0],
    configuration: { device: "opaque://one", token: "secret", removed: "old" },
  };
  expect(restoredConfiguration(source, installed)).toEqual({
    device: "opaque://one",
  });
  expect(
    restoredConfiguration(source, {
      ...installed,
      configuration: [
        { id: "device", label: "Device", kind: "password", required: true },
      ],
    }),
  ).toEqual({});
  expect(restoredConfiguration(source)).toEqual({});
  expect(
    restoredConfiguration(source, {
      ...installed,
      configuration: [
        { id: "device", label: "Device", kind: "number", required: false },
      ],
    }),
  ).toEqual({});
});
it("sends saved workspace revisions for updates and removal", async () => {
  invoke.mockReset().mockResolvedValue({
    id: "saved",
    revision: "new",
    profile: { kind: "adapters", ...options },
  });
  await nativeAdapterServices.profiles!.save(options, {
    id: "saved",
    revision: "old",
  });
  expect(invoke).toHaveBeenCalledWith("save_workspace_profile", {
    options,
    id: "saved",
    revision: "old",
  });
  await nativeAdapterServices.profiles!.remove("saved", "new");
  expect(invoke).toHaveBeenCalledWith("remove_workspace_profile", {
    id: "saved",
    revision: "new",
  });
});
it("keeps credentials out of reconnect profiles and preserves explicit source identity", () => {
  const profile = adapterProfile(options, [installed]);
  expect(JSON.stringify(profile)).not.toContain("secret");
  const updated = adapterProfile(
    {
      ...options,
      sources: [
        {
          ...options.sources[0],
          revision: "two",
          configuration: { device: "opaque://one", token: "new-secret" },
        },
      ],
    },
    [{ ...installed, revision: "two", version: "2.0.0" }],
  );
  expect(sameEndpoint(profile, updated)).toBe(true);
  expect(
    sameEndpoint(profile, { ...updated, bindings: { console: "files" } }),
  ).toBe(false);
  expect(
    sameEndpoint(profile, {
      ...updated,
      sources: [{ ...updated.sources[0], configuration: { device: "other" } }],
    }),
  ).toBe(false);
  expect(() =>
    adapterProfile(options, [{ ...installed, revision: "two" }]),
  ).toThrow(/changed/);
});
it("disconnects a late adapter result after cancellation and releases the native attempt", async () => {
  let finish!: (value: unknown) => void;
  invoke.mockReset().mockImplementation((method: string) => {
    if (method === "begin_connect") return Promise.resolve(17);
    if (method === "connect_adapters")
      return new Promise((resolve) => (finish = resolve));
    return Promise.resolve();
  });
  const controller = new AbortController();
  const connecting = nativeAdapterServices.connect(options, controller.signal);
  const rejected = expect(connecting).rejects.toThrow(/canceled/);
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("connect_adapters", {
      options,
      requestId: 17,
      onHostKey: expect.anything(),
    }),
  );
  controller.abort();
  finish({ id: 99 });
  await rejected;
  expect(invoke).toHaveBeenCalledWith("disconnect", { sessionId: 99 });
  expect(invoke).toHaveBeenCalledWith("cancel_connect", { requestId: 17 });
});
it("does not start an already canceled adapter connection", async () => {
  invoke.mockClear();
  const controller = new AbortController();
  controller.abort();
  await expect(
    nativeAdapterServices.connect(options, controller.signal),
  ).rejects.toThrow(/canceled/);
  expect(invoke).not.toHaveBeenCalled();
});
it("delivers a committed source replacement after late cancellation without disconnecting the workspace", async () => {
  let finish!: (value: unknown) => void;
  invoke.mockReset().mockImplementation((method: string) => {
    if (method === "begin_connect") return Promise.resolve(28);
    if (method === "replace_adapter_source")
      return new Promise((resolve) => {
        finish = resolve;
      });
    return Promise.resolve();
  });
  const expected = { instance: 4, generation: 1, adapter: installed.id };
  const controller = new AbortController();
  const pending = nativeAdapterServices.replaceSource!(
    77,
    expected,
    options,
    controller.signal,
  );
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("replace_adapter_source", {
      sessionId: 77,
      expected,
      options,
      requestId: 28,
      onHostKey: expect.anything(),
    }),
  );
  controller.abort();
  const result = {
    connected: true,
    sourceRevision: 1,
    services: [],
    connections: [],
  };
  finish(result);
  await expect(pending).resolves.toEqual(result);
  expect(invoke.mock.calls.some(([method]) => method === "disconnect")).toBe(
    false,
  );
  expect(invoke).toHaveBeenCalledWith("cancel_connect", { requestId: 28 });
});
