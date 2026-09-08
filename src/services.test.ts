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
