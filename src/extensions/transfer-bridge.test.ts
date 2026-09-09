// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { AppTransfers, type AppTransferSource } from "./transfer-bridge";
import { RpcPeer, type RpcTransport } from "./rpc";
import { appTransferClient } from "../../packages/app-sdk/src/transfer-client";
import { appClipboardClient } from "../../packages/app-sdk/src/clipboard-client";
import type { TransferOutcome, TransferProgress, TransferTicket } from "../sdk";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const entry = {
  binding: "first",
  path: "device:item",
  revision: "exact-revision",
};
const destination = { binding: "first", path: "device:destination" };
function setup(grants = ["files.upload", "files.download", "files.copy"]) {
  let serial = 0;
  const ticket = (direction: TransferTicket["direction"]): TransferTicket => ({
    id: ++serial,
    name: "sample",
    size: 100,
    direction,
  });
  const results = new Map<
    number,
    ReturnType<typeof deferred<TransferOutcome>>
  >();
  const progress = new Map<number, (event: TransferProgress) => void>();
  const services = {
    systemFileClipboard: true,
    pasteSystemFiles: vi.fn(
      async (_parent: string): Promise<TransferTicket[]> => [ticket("upload")],
    ),
    chooseUploads: vi.fn(async (_parent: string, _folder?: boolean) => [
      ticket("upload"),
      ticket("upload"),
    ]),
    chooseDownload: vi.fn(
      async (_path: string, _revision: string) =>
        ticket("download") as TransferTicket | null,
    ),
    chooseDownloads: vi.fn(
      async (_entries: { path: string; revision: string }[]) => [
        ticket("download"),
      ],
    ),
    prepareCopy: vi.fn(
      async (_path: string, _revision: string, _parent: string) =>
        ticket("copy"),
    ),
    runTransfer: vi.fn(
      async (
        job: TransferTicket,
        callback: (event: TransferProgress) => void,
      ) => {
        const result = deferred<TransferOutcome>();
        results.set(job.id, result);
        progress.set(job.id, callback);
        return result.promise;
      },
    ),
    cancelTransfer: vi.fn(async (_id: number) => {}),
  };
  let source: AppTransferSource = { binding: "first", services };
  const missing = new Set<string>();
  const busy = vi.fn(),
    report = vi.fn();
  const owner = new AppTransfers(
    () => source,
    (capability) => !missing.has(capability),
    busy,
    report,
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
    owner,
    services,
    results,
    progress,
    busy,
    report,
    missing,
    peer,
    api: appTransferClient(peer),
    replace() {
      source = { binding: "second", services: { ...services } };
      owner.refresh();
    },
    finish(
      id: number,
      status: TransferOutcome["status"] = "completed",
      path = "device:result",
    ) {
      results.get(id)!.resolve({ status, bytes: 100, total: 100, path });
    },
    close() {
      peer.close();
      server.close();
      owner.close();
      for (const result of results.values())
        result.resolve({ status: "canceled", bytes: 0, total: 100 });
    },
  };
}
it("prepares without starting, keeps native tickets private, coalesces progress and starts each job once", async () => {
  const t = setup();
  try {
    const job = await t.api.copy(entry, destination);
    expect(t.services.runTransfer).not.toHaveBeenCalled();
    expect(t.services.prepareCopy).toHaveBeenCalledWith(
      entry.path,
      entry.revision,
      destination.path,
    );
    expect(t.busy).toHaveBeenLastCalledWith(true);
    expect(job).not.toHaveProperty("id");
    const watcher = job.watch()[Symbol.asyncIterator]();
    expect((await watcher.next()).value).toMatchObject({ state: "queued" });
    const running = job.run(),
      duplicate = job.run();
    await vi.waitFor(() =>
      expect(t.services.runTransfer).toHaveBeenCalledOnce(),
    );
    const id = t.services.runTransfer.mock.calls[0][0].id;
    t.progress.get(id)!({ bytes: 20, total: 100, phase: "running" });
    t.progress.get(id)!({ bytes: 70, total: 100, phase: "running", items: 2 });
    const update = (await watcher.next()).value!;
    expect(update.progress).toEqual({
      bytes: 70,
      total: 100,
      phase: "running",
      items: 2,
    });
    t.finish(id);
    const result = await running;
    expect(await duplicate).toEqual(result);
    expect(result).toEqual({
      status: "completed",
      bytes: 100,
      total: 100,
      destination: { binding: "first", path: "device:result" },
    });
    expect((await watcher.next()).value!.result).toEqual(result);
    expect((await watcher.next()).done).toBe(true);
    expect(t.busy).toHaveBeenLastCalledWith(false);
    await job.close();
    await expect(job.status()).rejects.toMatchObject({ code: "closed" });
  } finally {
    t.close();
  }
});
it("prepares native clipboard files only with both grants and returns owned jobs without starting them", async () => {
  for (const grants of [
    [],
    ["files.upload"],
    ["system.clipboard.files.read"],
  ]) {
    const denied = setup(grants);
    try {
      await expect(
        appClipboardClient(denied.peer).pasteFiles(destination),
      ).rejects.toMatchObject({ code: "denied" });
      expect(denied.services.pasteSystemFiles).not.toHaveBeenCalled();
    } finally {
      denied.close();
    }
  }
  const t = setup(["files.upload", "system.clipboard.files.read"]);
  try {
    const clipboard = appClipboardClient(t.peer);
    const [job] = await clipboard.pasteFiles(destination);
    expect(t.services.pasteSystemFiles).toHaveBeenCalledWith(destination.path);
    expect(job).not.toHaveProperty("id");
    expect(t.services.runTransfer).not.toHaveBeenCalled();
    expect(t.busy).toHaveBeenLastCalledWith(true);
    const running = job.run();
    await vi.waitFor(() => expect(t.results.size).toBe(1));
    t.finish([...t.results.keys()][0]);
    expect(await running).toMatchObject({
      status: "completed",
      destination: { binding: "first", path: "device:result" },
    });
    await job.close();
    t.services.pasteSystemFiles.mockResolvedValueOnce([]);
    expect(await clipboard.pasteFiles(destination)).toEqual([]);
    expect(t.busy).toHaveBeenLastCalledWith(false);
    t.services.systemFileClipboard = false;
    await expect(clipboard.pasteFiles(destination)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(t.services.pasteSystemFiles).toHaveBeenCalledTimes(2);
  } finally {
    t.close();
  }
});
it("keeps canceled clipboard preparation busy until late tickets are released and never routes it to a replacement", async () => {
  const t = setup(["files.upload", "system.clipboard.files.read"]);
  const pending = deferred<TransferTicket[]>();
  t.services.pasteSystemFiles.mockReturnValueOnce(pending.promise);
  try {
    const abort = new AbortController();
    const result = appClipboardClient(t.peer).pasteFiles(
      destination,
      abort.signal,
    );
    const rejected = expect(result).rejects.toMatchObject({ code: "aborted" });
    await vi.waitFor(() =>
      expect(t.services.pasteSystemFiles).toHaveBeenCalledOnce(),
    );
    abort.abort();
    await rejected;
    expect(t.busy).toHaveBeenLastCalledWith(true);
    t.replace();
    pending.resolve([
      { id: 99, name: "1000 clipboard items", size: 1000, direction: "upload" },
    ]);
    await vi.waitFor(() =>
      expect(t.services.cancelTransfer).toHaveBeenCalledWith(99),
    );
    await vi.waitFor(() => expect(t.busy).toHaveBeenLastCalledWith(false));
    expect(t.services.runTransfer).not.toHaveBeenCalled();
  } finally {
    t.close();
  }
});
it("enforces permissions and binding checks before choosers, supports folder selection and hides local paths", async () => {
  const denied = setup([]),
    t = setup();
  try {
    await expect(denied.api.upload(destination)).rejects.toMatchObject({
      code: "denied",
    });
    expect(denied.services.chooseUploads).not.toHaveBeenCalled();
    await expect(
      t.api.copy(entry, { ...destination, binding: "other" }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      t.api.downloadMany([entry, { ...entry, binding: "other" }]),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(t.services.chooseDownloads).not.toHaveBeenCalled();
    expect(t.services.prepareCopy).not.toHaveBeenCalled();
    t.missing.add("files.folders");
    await expect(
      t.api.upload(destination, { folder: true }),
    ).rejects.toMatchObject({ code: "unavailable" });
    t.missing.clear();
    const uploads = await t.api.upload(destination, { folder: true });
    expect(t.services.chooseUploads).toHaveBeenCalledWith(
      destination.path,
      true,
    );
    await Promise.all(uploads.map((job) => job.close()));
    t.services.chooseDownload.mockResolvedValueOnce(null);
    expect(await t.api.download(entry)).toBeNull();
    const job = (await t.api.download(entry))!;
    const running = job.run();
    await vi.waitFor(() => expect(t.results.size).toBe(1));
    t.finish(
      [...t.results.keys()][0],
      "completed",
      "C:\\private\\destination.txt",
    );
    expect(await running).not.toHaveProperty("destination");
    expect(JSON.stringify(await job.status())).not.toContain("private");
    await job.close();
  } finally {
    denied.close();
    t.close();
  }
});
it("cancels late chooser tickets without running them and keeps the chooser charged until it returns", async () => {
  const t = setup();
  const picker = deferred<TransferTicket[]>();
  t.services.chooseUploads.mockReturnValueOnce(picker.promise);
  try {
    const abort = new AbortController();
    const prepared = t.api.upload(destination, {}, abort.signal);
    const rejected = expect(prepared).rejects.toMatchObject({
      code: "aborted",
    });
    await vi.waitFor(() =>
      expect(t.services.chooseUploads).toHaveBeenCalledOnce(),
    );
    abort.abort();
    await rejected;
    await expect(t.api.upload(destination)).rejects.toMatchObject({
      code: "busy",
    });
    expect(t.busy).toHaveBeenLastCalledWith(true);
    picker.resolve([
      { id: 80, name: "late", size: 10, direction: "upload" },
      { id: 81, name: "late-2", size: 20, direction: "upload" },
    ]);
    await vi.waitFor(() =>
      expect(t.services.cancelTransfer).toHaveBeenCalledTimes(2),
    );
    expect(t.services.runTransfer).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(t.busy).toHaveBeenLastCalledWith(false));
  } finally {
    t.close();
  }
});
it("allows host retry of failed cleanup for chooser tickets the app never received", async () => {
  const t = setup();
  const picker = deferred<TransferTicket[]>();
  t.services.chooseUploads.mockReturnValueOnce(picker.promise);
  try {
    const abort = new AbortController();
    const prepared = t.api.upload(destination, {}, abort.signal);
    const rejected = expect(prepared).rejects.toMatchObject({
      code: "aborted",
    });
    await vi.waitFor(() =>
      expect(t.services.chooseUploads).toHaveBeenCalledOnce(),
    );
    abort.abort();
    await rejected;
    t.services.cancelTransfer.mockRejectedValueOnce(
      new Error("Cleanup unavailable"),
    );
    picker.resolve([{ id: 82, name: "late", size: 10, direction: "upload" }]);
    await vi.waitFor(() => expect(t.report).toHaveBeenCalledOnce());
    expect(t.busy).toHaveBeenLastCalledWith(true);
    await t.owner.retryCleanup();
    expect(t.services.cancelTransfer).toHaveBeenCalledTimes(2);
    expect(t.services.runTransfer).not.toHaveBeenCalled();
    expect(t.busy).toHaveBeenLastCalledWith(false);
  } finally {
    t.close();
  }
});
it("waits for an authoritative running result and preserves completion after a late cancellation", async () => {
  const t = setup();
  try {
    const job = await t.api.copy(entry, destination);
    const abort = new AbortController();
    const running = job.run(abort.signal);
    await vi.waitFor(() => expect(t.results.size).toBe(1));
    abort.abort();
    await vi.waitFor(() =>
      expect(t.services.cancelTransfer).toHaveBeenCalledOnce(),
    );
    expect(await job.status()).toMatchObject({ state: "canceling" });
    expect(t.busy).toHaveBeenLastCalledWith(true);
    let done = false;
    const closed = job.close().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    t.finish([...t.results.keys()][0]);
    expect(await running).toMatchObject({ status: "completed" });
    await closed;
    expect(t.busy).toHaveBeenLastCalledWith(false);
  } finally {
    t.close();
  }
});
it("retains failed cancellation for retry, never starts an unwanted queued job and protects other windows", async () => {
  const a = setup(),
    b = setup();
  try {
    const raw = (await a.peer.call("system.transfers.copy", {
      id: "prepare",
      binding: "first",
      path: entry.path,
      revision: entry.revision,
      parent: destination.path,
      parentBinding: "first",
    })) as { id: string }[];
    await expect(
      b.peer.call("system.transfers.run", { id: raw[0].id }),
    ).rejects.toMatchObject({ code: "closed" });
    await b.peer.call("system.transfers.close", { id: raw[0].id });
    expect(a.services.cancelTransfer).not.toHaveBeenCalled();
    a.services.cancelTransfer.mockRejectedValueOnce(
      new Error("Transport unavailable"),
    );
    await expect(
      a.peer.call("system.transfers.cancel", { id: raw[0].id }),
    ).rejects.toMatchObject({ code: "failed" });
    expect(
      await a.peer.call("system.transfers.status", {
        id: raw[0].id,
        after: null,
      }),
    ).toMatchObject({ state: "cancel-failed" });
    await expect(
      a.peer.call("system.transfers.run", { id: raw[0].id }),
    ).rejects.toMatchObject({ code: "busy" });
    expect(a.busy).toHaveBeenLastCalledWith(true);
    await a.peer.call("system.transfers.close", { id: raw[0].id });
    expect(a.services.runTransfer).not.toHaveBeenCalled();
    expect(a.busy).toHaveBeenLastCalledWith(false);
  } finally {
    a.close();
    b.close();
  }
});
it("retires queued work on source changes and aborting a watcher leaves its transfer owned", async () => {
  const t = setup();
  try {
    const job = await t.api.copy(entry, destination);
    const abort = new AbortController();
    const watcher = job.watch(abort.signal)[Symbol.asyncIterator]();
    await watcher.next();
    const waiting = watcher.next();
    const rejected = expect(waiting).rejects.toMatchObject({ code: "aborted" });
    // A status read must remain available while another caller waits for progress.
    expect(await job.status()).toMatchObject({ state: "queued" });
    abort.abort();
    await rejected;
    expect(t.services.cancelTransfer).not.toHaveBeenCalled();
    expect(await job.status()).toMatchObject({ state: "queued" });
    t.replace();
    await vi.waitFor(() =>
      expect(t.services.cancelTransfer).toHaveBeenCalledOnce(),
    );
    expect(await job.run()).toMatchObject({ status: "canceled" });
    expect(t.services.runTransfer).not.toHaveBeenCalled();
    await job.close();
  } finally {
    t.close();
  }
});
it("cancels unexpected ticket directions and folders whose support disappears during selection", async () => {
  const t = setup();
  try {
    t.services.prepareCopy.mockResolvedValueOnce({
      id: 99,
      direction: "upload",
      name: "wrong",
      size: 1,
    });
    await expect(t.api.copy(entry, destination)).rejects.toMatchObject({
      code: "closed",
    });
    await vi.waitFor(() =>
      expect(t.services.cancelTransfer).toHaveBeenCalledWith(99),
    );
    const chooser = deferred<TransferTicket[]>();
    t.services.chooseUploads.mockReturnValueOnce(chooser.promise);
    const pending = t.api.upload(destination, { folder: true });
    const rejected = expect(pending).rejects.toMatchObject({ code: "closed" });
    await vi.waitFor(() =>
      expect(t.services.chooseUploads).toHaveBeenCalledOnce(),
    );
    t.missing.add("files.folders");
    chooser.resolve([
      { id: 100, direction: "upload", name: "folder", size: 0 },
    ]);
    await rejected;
    await vi.waitFor(() =>
      expect(t.services.cancelTransfer).toHaveBeenCalledWith(100),
    );
    expect(t.services.runTransfer).not.toHaveBeenCalled();
    expect(t.busy).toHaveBeenLastCalledWith(false);
  } finally {
    t.close();
  }
});
