// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import {
  AppFileClipboard,
  type AppFileClipboardSource,
} from "./file-clipboard-api";
import { RpcPeer, type RpcTransport } from "./rpc";
import { appClipboardClient } from "../../packages/app-sdk/src/clipboard-client";
import type { ClipboardPreparation } from "../sdk";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const entries = [{ binding: "first", path: "opaque:file", revision: "r1" }];
function setup(grants = ["system.clipboard.files.write", "files.download"]) {
  const services = {
    systemFileClipboard: true,
    copyToSystem: vi.fn(
      async (
        _files: { path: string; revision: string }[],
        _preparation?: ClipboardPreparation,
      ) => 42,
    ),
    cancelClipboardPreparation: vi.fn(async (_id: string) => {}),
  };
  let source: AppFileClipboardSource = { binding: "first", services };
  const busy = vi.fn();
  const owner = new AppFileClipboard(
    () => source,
    () => true,
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
  const server = new RpcPeer(transports[1], owner.methods(), grants);
  const peer = new RpcPeer(transports[0]);
  server.onClose(() => owner.close());
  return {
    services,
    busy,
    owner,
    peer,
    api: appClipboardClient(peer),
    replace() {
      source = { binding: "second", services: { ...services } };
      owner.refresh();
    },
    close() {
      peer.close();
      server.close();
      owner.close();
    },
  };
}
it("chunks large selections, snapshots revisions and exports once without exposing native operation identities", async () => {
  const t = setup();
  try {
    const files = Array.from({ length: 1000 }, (_, i) => ({
      ...entries[0],
      path: `entry:${i}`,
    }));
    const copied = t.api.copyFiles(files);
    files[0].revision = "changed-after-call";
    await copied;
    expect(t.services.copyToSystem).toHaveBeenCalledOnce();
    const [captured, preparation] = t.services.copyToSystem.mock.calls[0];
    expect(captured).toHaveLength(1000);
    expect(captured[0]).toEqual({ path: "entry:0", revision: "r1" });
    expect(preparation?.id).toMatch(/^[a-f0-9-]+$/);
    expect(t.busy.mock.calls.map(([value]) => value)).toEqual([true, false]);
  } finally {
    t.close();
  }
});
it("requires separate export and file-download permissions before accessing the backend", async () => {
  for (const grants of [
    [],
    ["files.download"],
    ["system.clipboard.files.write"],
  ]) {
    const t = setup(grants);
    try {
      await expect(t.api.copyFiles(entries)).rejects.toMatchObject({
        code: "denied",
      });
      expect(t.services.copyToSystem).not.toHaveBeenCalled();
      expect(t.busy).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  }
});
it("keeps long opaque references below the RPC envelope without a total selection cap", async () => {
  const t = setup();
  try {
    const files = Array.from({ length: 140 }, (_, i) => ({
      ...entries[0],
      path: `entry-${i}:` + "a".repeat(40000),
    }));
    await t.api.copyFiles(files);
    expect(t.services.copyToSystem.mock.calls[0][0]).toEqual(
      files.map(({ path, revision }) => ({ path, revision })),
    );
  } finally {
    t.close();
  }
});
it("refuses mixed bindings, empty selections and unsupported desktops", async () => {
  const t = setup();
  try {
    await expect(t.api.copyFiles([])).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(
      t.api.copyFiles([...entries, { ...entries[0], binding: "second" }]),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      t.api.copyFiles([{ ...entries[0], binding: "old" }]),
    ).rejects.toMatchObject({ code: "closed" });
    t.services.systemFileClipboard = false;
    await expect(t.api.copyFiles(entries)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(t.services.copyToSystem).not.toHaveBeenCalled();
  } finally {
    t.close();
  }
});
it("rejects foreign and out-of-order chunks and never publishes partial invalid selections", async () => {
  const t = setup();
  const call = (method: string, params: any) =>
    t.peer.call(`system.clipboard.files.${method}`, params);
  try {
    await call("start", { id: "owner", binding: "first" });
    await expect(
      call("append", { id: "foreign", offset: 0, entries }),
    ).rejects.toMatchObject({ code: "closed" });
    await expect(
      call("append", {
        id: "owner",
        offset: 1,
        entries: [{ path: "one", revision: "r1" }],
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      call("append", {
        id: "owner",
        offset: 0,
        entries: [{ path: "one", revision: "r1" }, { path: "bad" }],
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(call("commit", { id: "owner" })).rejects.toMatchObject({
      code: "invalid",
    });
    await call("release", { id: "foreign" });
    await expect(t.api.copyFiles(entries)).rejects.toMatchObject({
      code: "busy",
    });
    expect(t.services.copyToSystem).not.toHaveBeenCalled();
    await call("release", { id: "owner" });
    await t.api.copyFiles(entries);
    expect(t.services.copyToSystem).toHaveBeenCalledOnce();
  } finally {
    t.close();
  }
});
it("keeps cancellation busy until native completion and retries a cancellation racing registration", async () => {
  const t = setup(),
    pending = deferred<number>(),
    canceled = deferred<void>();
  t.services.copyToSystem.mockReturnValueOnce(pending.promise);
  t.services.cancelClipboardPreparation.mockReturnValueOnce(canceled.promise);
  try {
    const abort = new AbortController();
    const copy = t.api.copyFiles(entries, abort.signal);
    const rejected = expect(copy).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() =>
      expect(t.services.copyToSystem).toHaveBeenCalledOnce(),
    );
    abort.abort();
    await rejected;
    expect(t.busy).toHaveBeenLastCalledWith(true);
    await expect(t.api.copyFiles(entries)).rejects.toMatchObject({
      code: "busy",
    });
    const preparation = t.services.copyToSystem.mock.calls[0][1]!;
    preparation.onProgress!({ bytes: 0, total: 0, phase: "preparing" });
    canceled.resolve();
    await vi.waitFor(() =>
      expect(t.services.cancelClipboardPreparation).toHaveBeenCalledTimes(2),
    );
    expect(
      t.services.cancelClipboardPreparation.mock.calls.every(
        ([id]) => id === preparation.id,
      ),
    ).toBe(true);
    pending.resolve(42);
    await vi.waitFor(() => expect(t.busy).toHaveBeenLastCalledWith(false));
    expect(t.services.copyToSystem).toHaveBeenCalledOnce();
  } finally {
    pending.resolve(42);
    canceled.resolve();
    t.close();
  }
});
it("retires staged references and cancels publications on source replacement or app closure", async () => {
  for (const close of [false, true]) {
    const t = setup(),
      pending = deferred<number>();
    t.services.copyToSystem.mockReturnValueOnce(pending.promise);
    try {
      const copy = t.api.copyFiles(entries);
      const rejected = expect(copy).rejects.toMatchObject({ code: "aborted" });
      await vi.waitFor(() =>
        expect(t.services.copyToSystem).toHaveBeenCalledOnce(),
      );
      if (close) t.owner.close();
      else t.replace();
      await vi.waitFor(() =>
        expect(t.services.cancelClipboardPreparation).toHaveBeenCalledOnce(),
      );
      expect(t.busy).toHaveBeenLastCalledWith(true);
      pending.resolve(42);
      await rejected;
      expect(t.busy).toHaveBeenLastCalledWith(false);
    } finally {
      pending.resolve(42);
      t.close();
    }
  }
});
