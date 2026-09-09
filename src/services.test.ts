// SPDX-License-Identifier: MPL-2.0
import { beforeEach, expect, it, vi } from "vitest";
import type { HostKeyChallenge, Session } from "./sdk";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  isTauri: () => true,
  Channel: class {
    onmessage?: (value: HostKeyChallenge) => void;
  },
}));
import { nativeServices } from "./services";
import { bindSession } from "./session-services";
import { previewSession } from "./preview";

it("acknowledges output only after consumption and preserves queued binary input", async () => {
  let event!: (value: {
    type: "output";
    data: number[];
    sequence: number;
  }) => void;
  const consumed = deferred<void>();
  invoke.mockImplementation(async (command, args) => {
    if (command === "open_terminal") {
      event = args.onEvent.onmessage;
      return { id: 90, resizable: false };
    }
  });
  const received = vi.fn(() => consumed.promise);
  const console = await nativeServices.terminal(700, 80, 24, received);
  expect(console.resizable).toBe(false);
  event({ type: "output", data: [0, 255, 240], sequence: 1 });
  await Promise.resolve();
  expect(
    invoke.mock.calls.some(
      ([command]) => command === "acknowledge_terminal_output",
    ),
  ).toBe(false);
  const bytes = Uint8Array.from({ length: 33000 }, (_, i) => i % 256);
  const written = console.write(bytes);
  bytes.fill(42);
  await written;
  const parts = invoke.mock.calls
    .filter(([command]) => command === "terminal_input")
    .map(([, args]) => args.data as number[]);
  expect(parts.map((part) => part.length)).toEqual([16384, 16384, 232]);
  expect(parts.flat()).toEqual(
    Array.from({ length: 33000 }, (_, i) => i % 256),
  );
  consumed.resolve();
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("acknowledge_terminal_output", {
      sessionId: 700,
      terminalId: 90,
      sequence: 1,
    }),
  );
  await console.close();
  await expect(console.write("closed")).rejects.toThrow("closed");
});

it("captures each source once and attaches it to all native service requests", async () => {
  const files = { instance: 11, generation: 1, adapter: "files" };
  const consoleSource = { instance: 12, generation: 1, adapter: "console" };
  const settings = { instance: 13, generation: 1, adapter: "settings" };
  const session: Session = {
    ...previewSession,
    id: 700,
    services: [
      { capability: "files.read", state: "available", source: files },
      { capability: "terminal", state: "available", source: consoleSource },
      { capability: "host.settings", state: "available", source: settings },
    ],
  };
  const bound = nativeServices.bindSources!(session);
  files.generation = 2;
  const requests = [
    () => bound.list(700),
    () => bound.openDirectory!(700),
    () => bound.preview(700, "opaque"),
    () => bound.readText(700, "opaque"),
    () => bound.saveText(700, "opaque", "text", "rev"),
    () => bound.createText(700, "opaque", "name", "text"),
    () => bound.makeDirectory(700, "opaque", "name"),
    () => bound.renameEntry(700, "opaque", "name", "rev", []),
    () => bound.moveEntry(700, "opaque", "target", "rev", []),
    () => bound.removeEntry(700, "opaque", "rev"),
    () => bound.chooseDownload(700, "opaque", "rev"),
    () => bound.chooseDownloads(700, [{ path: "opaque", revision: "rev" }]),
    () => bound.chooseUploads(700, "opaque"),
    () => bound.prepareCopy(700, "opaque", "rev", "target"),
    () => bound.copyToSystem(700, [{ path: "opaque", revision: "rev" }]),
    () => bound.cutToSystem(700, "opaque", "rev"),
    () => bound.pasteSystemFiles(700, "opaque"),
  ];
  for (const request of requests) {
    await request();
    expect(invoke.mock.lastCall?.[1].binding).toEqual({
      ...files,
      generation: 1,
    });
  }
  await bound.readHostSettings(700);
  expect(invoke.mock.lastCall?.[1].binding).toEqual(settings);
  await bound.applyHostSetting(700, "timezone", "UTC", "rev");
  expect(invoke.mock.lastCall?.[1].binding).toEqual(settings);
  const terminal = await bound.terminal(700, 80, 24, () => {});
  expect(invoke.mock.lastCall?.[1].binding).toEqual(consoleSource);
  // Existing stream/ticket handles remain usable for cleanup after retirement.
  await terminal.close();
  expect(invoke.mock.lastCall?.[1]).not.toHaveProperty("binding");
  await bound.cancelTransfer(700, 7);
  expect(invoke.mock.lastCall?.[1]).not.toHaveProperty("binding");
  const before = invoke.mock.calls.length;
  await expect(bound.list(701)).rejects.toThrow("another workspace");
  const missing = nativeServices.bindSources!({ ...session, services: [] });
  await expect(missing.list(700)).rejects.toThrow("No accepted connection");
  expect(invoke.mock.calls.length).toBe(before);
});

it("availability updates cannot silently repin an accepted app service", async () => {
  const first = { instance: 21, generation: 1, adapter: "files" };
  const next = { instance: 22, generation: 1, adapter: "files" };
  const session: Session = {
    ...previewSession,
    id: 800,
    services: [{ capability: "files.read", state: "available", source: first }],
  };
  const owner = bindSession(nativeServices, session);
  const replaced: Session = {
    ...session,
    services: [{ capability: "files.read", state: "available", source: next }],
  };
  owner.updateAvailability(replaced);
  const before = invoke.mock.calls.length;
  await expect(owner.services.list()).rejects.toThrow("no longer connected");
  expect(invoke.mock.calls.length).toBe(before);
  const accepted = bindSession(nativeServices, replaced);
  await accepted.services.list();
  expect(invoke.mock.lastCall?.[1].binding).toEqual(next);
  owner.dispose();
  accepted.dispose();
});

const options = {
  host: "server",
  port: 2222,
  username: "fixture",
  keyPath: "",
};
const challenge: HostKeyChallenge = {
  host: "SERVER",
  port: 2222,
  token: "one-use-token",
  algorithm: "ssh-ed25519",
  fingerprint: "SHA256:fixture",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let connected: ReturnType<typeof deferred<Session>>;
let channel: { onmessage: (value: HostKeyChallenge) => void };
beforeEach(() => {
  invoke.mockReset();
  connected = deferred<Session>();
  invoke.mockImplementation(async (command, args) => {
    if (command === "open_terminal") return { id: 50, resizable: true };
    if (command === "begin_connect") return 42;
    if (command === "connect") {
      channel = args.onHostKey;
      return connected.promise;
    }
    if (command === "cancel_connect")
      connected.reject(new Error("Connection canceled"));
  });
});
async function reviewing() {
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("connect", expect.anything()),
  );
}
it("binds an explicit decision to the native attempt and token, and refuses without a reviewer", async () => {
  for (const approve of [true, false, undefined]) {
    const review =
      approve === undefined ? undefined : vi.fn(async () => approve);
    const pending = nativeServices.connect(options, undefined, review);
    await reviewing();
    channel.onmessage(challenge);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("decide_host_key", {
        requestId: 42,
        token: challenge.token,
        approve: approve ?? false,
      }),
    );
    const result = expect(pending).rejects.toThrow("fixture finished");
    connected.reject(new Error("fixture finished"));
    await result;
    invoke.mockClear();
    connected = deferred<Session>();
  }
});
it.each(["cancel", "finished"])(
  "ignores late approval after %s",
  async (ending) => {
    const answer = deferred<boolean>();
    const controller = new AbortController();
    const review = vi.fn(() => answer.promise);
    const pending = nativeServices.connect(options, controller.signal, review);
    const rejected = expect(pending).rejects.toThrow();
    await reviewing();
    channel.onmessage(challenge);
    await vi.waitFor(() => expect(review).toHaveBeenCalledOnce());
    if (ending === "cancel") controller.abort();
    else connected.reject(new Error("Host review expired"));
    await rejected;
    answer.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(
      invoke.mock.calls.filter(([command]) => command === "decide_host_key"),
    ).toEqual([]);
  },
);
it("rejects a challenge for a different endpoint without presenting it", async () => {
  const review = vi.fn(async () => true);
  const pending = nativeServices.connect(options, undefined, review);
  const rejected = expect(pending).rejects.toThrow("does not match");
  await reviewing();
  channel.onmessage({ ...challenge, port: 22 });
  await rejected;
  expect(review).not.toHaveBeenCalled();
  expect(
    invoke.mock.calls.filter(([command]) => command === "decide_host_key"),
  ).toEqual([]);
});
it("propagates reviewer failures and cancels the native attempt", async () => {
  const pending = nativeServices.connect(options, undefined, async () => {
    throw new Error("Review unavailable");
  });
  const rejected = expect(pending).rejects.toThrow("Review unavailable");
  await reviewing();
  channel.onmessage(challenge);
  await rejected;
  expect(invoke).toHaveBeenCalledWith("cancel_connect", { requestId: 42 });
});
