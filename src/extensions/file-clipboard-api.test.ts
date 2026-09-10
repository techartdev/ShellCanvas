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
    cutToSystem: vi.fn(
      async (
        _path: string,
        _revision: string,
        _preparation?: ClipboardPreparation,
      ) => 43,
    ),
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
  const unavailable = new Set<"copy" | "cut">();
  const owner = new AppFileClipboard(
    () => source,
    (kind) => !unavailable.has(kind),
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
    unavailable,
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
it("bounds the aggregate number of staged file references", async () => {
  const t = setup();
  try {
    await t.peer.call("system.clipboard.files.start", {
      id: "bounded-copy",
      binding: "first",
    });
    for (let offset = 0; offset < 4096; offset += 128)
      await t.peer.call("system.clipboard.files.append", {
        id: "bounded-copy",
        offset,
        entries: Array.from({ length: 128 }, (_, index) => ({
          path: `entry:${offset + index}`,
          revision: "r1",
        })),
      });
    await expect(
      t.peer.call("system.clipboard.files.append", {
        id: "bounded-copy",
        offset: 4096,
        entries: [{ path: "entry:overflow", revision: "r1" }],
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(t.services.copyToSystem).not.toHaveBeenCalled();
  } finally {
    t.close();
  }
});
it("publishes Cut with move and clipboard-write grants without requiring download support", async () => {
  const t = setup(["system.clipboard.files.write", "files.move"]);
  try {
    t.unavailable.add("copy");
    Object.defineProperty(t.services, "copyToSystem", { value: undefined });
    const entry = { ...entries[0] };
    const publication = t.api.cutFile(entry);
    entry.path = "changed-after-call";
    entry.revision = "changed-after-call";
    await publication;
    expect(t.services.cutToSystem).toHaveBeenCalledWith(
      entries[0].path,
      "r1",
      expect.objectContaining({
        id: expect.any(String),
        onProgress: expect.any(Function),
      }),
      false,
    );
    expect(t.busy.mock.calls.map(([value]) => value)).toEqual([true, false]);
  } finally {
    t.close();
  }
});
it("refuses Cut publication with missing grants, stale binding or invalid revisions", async () => {
  for (const grants of [
    [],
    ["files.move"],
    ["system.clipboard.files.write"],
    ["system.clipboard.files.write", "files.download"],
  ]) {
    const t = setup(grants);
    try {
      await expect(t.api.cutFile(entries[0])).rejects.toMatchObject({
        code: "denied",
      });
      expect(t.services.cutToSystem).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
  }
  const t = setup(["system.clipboard.files.write", "files.move"]);
  try {
    await expect(
      t.api.cutFile({ ...entries[0], binding: "foreign" }),
    ).rejects.toMatchObject({ code: "closed" });
    await expect(
      t.api.cutFile({ ...entries[0], revision: "" }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(t.services.cutToSystem).not.toHaveBeenCalled();
  } finally {
    t.close();
  }
});
it("shares the copy publication slot and keeps canceled Cut busy until the native outcome arrives", async () => {
  const t = setup([
    "system.clipboard.files.write",
    "files.move",
    "files.download",
  ]);
  const pending = deferred<number>();
  try {
    await t.peer.call("system.clipboard.files.start", {
      id: "staged-copy",
      binding: "first",
    });
    await expect(t.api.cutFile(entries[0])).rejects.toMatchObject({
      code: "busy",
    });
    await t.peer.call("system.clipboard.files.release", { id: "staged-copy" });
    t.services.cutToSystem.mockReturnValueOnce(pending.promise);
    const abort = new AbortController();
    const cut = t.api.cutFile(entries[0], abort.signal);
    const rejected = expect(cut).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() =>
      expect(t.services.cutToSystem).toHaveBeenCalledOnce(),
    );
    abort.abort();
    await rejected;
    await vi.waitFor(() =>
      expect(t.services.cancelClipboardPreparation).toHaveBeenCalled(),
    );
    expect(t.busy).toHaveBeenLastCalledWith(true);
    await expect(t.api.copyFiles(entries)).rejects.toMatchObject({
      code: "busy",
    });
    const preparation = t.services.cutToSystem.mock.calls[0][2]!;
    expect(
      t.services.cancelClipboardPreparation.mock.calls.every(
        ([id]) => id === preparation.id,
      ),
    ).toBe(true);
    pending.resolve(43);
    await vi.waitFor(() => expect(t.busy).toHaveBeenLastCalledWith(false));
    expect(t.services.cutToSystem).toHaveBeenCalledOnce();
  } finally {
    pending.resolve(43);
    t.close();
  }
});
it("retires Cut publication after source replacement, capability loss or app close without retargeting", async () => {
  for (const reason of ["replace", "capability", "close"]) {
    const t = setup(["system.clipboard.files.write", "files.move"]);
    const pending = deferred<number>();
    t.services.cutToSystem.mockReturnValueOnce(pending.promise);
    try {
      const cut = t.api.cutFile(entries[0]);
      const rejected = expect(cut).rejects.toMatchObject({ code: "aborted" });
      await vi.waitFor(() =>
        expect(t.services.cutToSystem).toHaveBeenCalledOnce(),
      );
      if (reason === "replace") t.replace();
      else if (reason === "close") t.owner.close();
      else {
        t.unavailable.add("cut");
        t.owner.refresh();
      }
      await vi.waitFor(() =>
        expect(t.services.cancelClipboardPreparation).toHaveBeenCalled(),
      );
      expect(t.busy).toHaveBeenLastCalledWith(true);
      pending.resolve(43);
      await rejected;
      expect(t.services.cutToSystem).toHaveBeenCalledOnce();
      expect(t.busy).toHaveBeenLastCalledWith(false);
    } finally {
      pending.resolve(43);
      t.close();
    }
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
it("keeps long opaque references below the RPC envelope and aggregate budget", async () => {
  const t = setup();
  try {
    const files = Array.from({ length: 20 }, (_, i) => ({
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
