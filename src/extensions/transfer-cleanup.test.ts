// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { bindSession } from "../session-services";
import { scopeAppServices } from "../app-services";
import { previewServices, previewSession } from "../preview";
import { defineApps, type TransferTicket } from "../sdk";
import { watchFileLocations } from "../file-events";
import { AppTransfers } from "./transfer-bridge";
import { RpcPeer, type RpcTransport } from "./rpc";
import { appTransferClient } from "../../packages/app-sdk/src/transfer-client";
import { fileClipboard } from "../file-clipboard";
import { TransferQueue, pendingTransfer } from "../transfer-queue";

let nextSession = 9200;
function harness() {
  const id = ++nextSession;
  let nextTicket = 0;
  let rejectCleanup = true;
  const nativeJobs = new Set<number>();
  const pasteMovedFiles = vi.fn(async () => {
    const ticket = {
      id: ++nextTicket,
      name: "cut",
      size: 0,
      direction: "move" as const,
    };
    nativeJobs.add(ticket.id);
    return [ticket];
  });
  const cancelTransfer = vi.fn(async (_session: number, ticket: number) => {
    if (rejectCleanup) throw new Error("Synthetic cleanup IPC failure");
    nativeJobs.delete(ticket);
  });
  const runTransfer = vi.fn(async () => ({
    status: "completed" as const,
    path: "target@new",
    bytes: 0,
    total: 0,
  }));
  const binding = bindSession(
    {
      ...previewServices,
      pasteMovedFiles,
      cancelTransfer,
      runTransfer,
      systemFileClipboard: true,
      inspectSystemFiles: async () => ({
        kind: "remote",
        intent: "move",
        sequence: 5,
      }),
    },
    {
      ...previewSession,
      id,
      info: { ...previewSession.info, capabilities: ["files.move"] },
    },
  );
  const app = (name: string) =>
    defineApps([
      {
        apiVersion: 1,
        id: name,
        title: name,
        subtitle: name,
        scope: "host",
        requires: ["files.move"],
        icon: () => null,
        component: () => null,
      },
    ])[0];
  const services = scopeAppServices(binding.services, app("move-owner"));
  const foreign = scopeAppServices(binding.services, app("foreign"));
  const unwatch = watchFileLocations(id, {
    snapshot: () => ({ paths: ["draft@1"], busy: true }),
    pending: vi.fn(),
    relocated: vi.fn(),
  });
  const busy = vi.fn(),
    report = vi.fn();
  const owner = new AppTransfers(
    () => ({ binding: "fixed", services }),
    () => true,
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
  const server = new RpcPeer(transports[1], owner.methods(), [
    "files.move",
    "system.clipboard.files.read",
  ]);
  const peer = new RpcPeer(transports[0]);
  server.onClose(() => owner.close());
  return {
    id,
    binding,
    services,
    foreign,
    owner,
    busy,
    report,
    nativeJobs,
    pasteMovedFiles,
    runTransfer,
    cancelTransfer,
    api: appTransferClient(peer),
    allowCleanup() {
      rejectCleanup = false;
    },
    stop() {
      rejectCleanup = false;
      unwatch();
      peer.close();
      server.close();
      owner.close();
      binding.dispose();
    },
  };
}

it("keeps a blocked move owned across session, app scope and SDK until cleanup is confirmed", async () => {
  const t = harness();
  try {
    const [job] = await t.api.pasteClipboard({
      binding: "fixed",
      path: "target",
    });
    expect(await job.run()).toMatchObject({
      status: "failed",
      message: expect.stringContaining("editor operations"),
    });
    expect(await job.status()).toMatchObject({
      state: "cancel-failed",
      cancellationError: expect.stringContaining("IPC failure"),
    });
    expect(await job.status()).not.toHaveProperty("result");
    expect(t.busy).toHaveBeenLastCalledWith(true);
    expect(t.nativeJobs.size).toBe(1);
    const raw: TransferTicket = {
      id: 1,
      direction: "move",
      name: "cut",
      size: 0,
    };
    await t.foreign.cancelTransfer(raw.id);
    expect(t.cancelTransfer).toHaveBeenCalledTimes(1);
    await expect(t.services.runTransfer(raw, () => {})).rejects.toThrow(
      "awaiting cancellation",
    );
    expect(t.runTransfer).not.toHaveBeenCalled();
    await expect(job.close()).rejects.toMatchObject({ code: "failed" });
    expect(t.nativeJobs.size).toBe(1);
    expect(t.busy).toHaveBeenLastCalledWith(true);
    t.allowCleanup();
    await t.owner.retryCleanup();
    expect(t.nativeJobs.size).toBe(0);
    expect(await job.status()).toMatchObject({
      state: "failed",
      result: { status: "failed" },
    });
    expect(t.busy).toHaveBeenLastCalledWith(false);
    await job.close();
    expect(t.pasteMovedFiles).toHaveBeenCalledOnce();
    expect(t.runTransfer).not.toHaveBeenCalled();
  } finally {
    t.stop();
  }
});

it("retains failed cleanup after the app disappears so the host can retry it", async () => {
  const t = harness();
  try {
    const [job] = await t.api.pasteClipboard({
      binding: "fixed",
      path: "target",
    });
    await job.run();
    t.owner.close();
    await vi.waitFor(() => expect(t.report).toHaveBeenCalled());
    expect(t.busy).toHaveBeenLastCalledWith(true);
    expect(t.nativeJobs.size).toBe(1);
    t.allowCleanup();
    await t.owner.retryCleanup();
    expect(t.nativeJobs.size).toBe(0);
    expect(t.busy).toHaveBeenLastCalledWith(false);
    expect(t.runTransfer).not.toHaveBeenCalled();
  } finally {
    t.stop();
  }
});

it("bundled clipboard retains failed reservations and retries cleanup without repeating the move", async () => {
  const t = harness();
  try {
    const clipboard = fileClipboard(t.binding.services);
    // No bundled cut item: the clipboard came from another app.
    await expect(clipboard.pasteSystem("target", 5)).rejects.toThrow(
      "IPC failure",
    );
    expect(clipboard.snapshot()).toMatchObject({
      item: null,
      working: false,
      cleanupPending: true,
    });
    clipboard.clear();
    await vi.waitFor(() => expect(clipboard.snapshot().working).toBe(false));
    expect(clipboard.snapshot().cleanupPending).toBe(true);
    expect(t.nativeJobs.size).toBe(1);
    t.allowCleanup();
    clipboard.clear();
    await vi.waitFor(() =>
      expect(clipboard.snapshot().cleanupPending).toBe(false),
    );
    expect(t.nativeJobs.size).toBe(0);
    expect(t.runTransfer).not.toHaveBeenCalled();
    expect(t.pasteMovedFiles).toHaveBeenCalledOnce();
  } finally {
    t.stop();
  }
});

it("transfer rows keep failed reservation cleanup pending and never pump it again", async () => {
  const t = harness();
  const queue = new TransferQueue(t.services);
  try {
    queue.enqueue(await t.services.pasteMovedFiles!("target", 5));
    await vi.waitFor(() =>
      expect(queue.snapshot()[0].status).toBe("cancel-failed"),
    );
    expect(pendingTransfer(queue.snapshot()[0])).toBe(true);
    queue.clearFinished();
    expect(queue.snapshot()).toHaveLength(1);
    t.allowCleanup();
    await queue.cancel(queue.snapshot()[0].id);
    expect(queue.snapshot()[0].status).toBe("canceled");
    expect(t.nativeJobs.size).toBe(0);
    expect(t.runTransfer).not.toHaveBeenCalled();
  } finally {
    queue.dispose();
    t.stop();
  }
});
