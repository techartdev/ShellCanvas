// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { pendingTransfer, TransferQueue } from "./transfer-queue";
import { bindSession } from "./session-services";
import { previewServices, previewSession } from "./preview";
import type {
  SessionServices,
  TransferConflictReview,
  TransferOutcome,
  TransferPolicy,
  TransferTicket,
} from "./sdk";
const ticket = (id: number): TransferTicket => ({
  id,
  name: `file${id}`,
  size: 64,
  direction: "upload",
});
const session = {
  ...previewSession,
  info: { ...previewSession.info, capabilities: ["files.upload" as const] },
};
it("runs sequentially, cancels queued files without starting them, and waits for active cancellation outcome", async () => {
  const done = new Map<number, (outcome: TransferOutcome) => void>();
  const runTransfer = vi.fn(
    (_: number, id: number) =>
      new Promise<TransferOutcome>((resolve) => done.set(id, resolve)),
  );
  const cancelTransfer = vi.fn(async () => {});
  const binding = bindSession(
    {
      ...previewServices,
      chooseUploads: async () => [ticket(1), ticket(2), ticket(3)],
      runTransfer,
      cancelTransfer,
    },
    session,
  );
  const queue = new TransferQueue(binding.services);
  queue.enqueue(await binding.services.chooseUploads("opaque-parent"));
  expect(runTransfer).toHaveBeenCalledTimes(1);
  await queue.cancel(2);
  await queue.cancel(1);
  expect(queue.snapshot().map((row) => row.status)).toEqual([
    "canceling",
    "canceled",
    "queued",
  ]);
  done.get(1)!({ status: "canceled", bytes: 32, total: 64 });
  await vi.waitFor(() => expect(runTransfer).toHaveBeenCalledTimes(2));
  expect(runTransfer.mock.calls.map((call) => call[1])).toEqual([1, 3]);
  done.get(3)!({
    status: "completed",
    bytes: 64,
    total: 64,
    path: "opaque-result",
  });
  await vi.waitFor(() => expect(queue.snapshot()[2].status).toBe("completed"));
  expect(cancelTransfer.mock.calls.length).toBe(2);
  queue.clearFinished();
  expect(queue.snapshot()).toEqual([]);
});
it("releases late file selections after disposal and does not pass an unowned transfer to the backend", async () => {
  let finish!: (tickets: TransferTicket[]) => void;
  const cancelTransfer = vi.fn(async () => {}),
    runTransfer = vi.fn(previewServices.runTransfer);
  const binding = bindSession(
    {
      ...previewServices,
      chooseUploads: () => new Promise((resolve) => (finish = resolve)),
      cancelTransfer,
      runTransfer,
    },
    session,
  );
  const pending = binding.services.chooseUploads("opaque-parent");
  binding.dispose();
  finish([ticket(8)]);
  await expect(pending).rejects.toThrow("no longer connected");
  expect(cancelTransfer).toHaveBeenCalledWith(session.id, 8);
  binding.activate();
  await expect(
    binding.services.runTransfer(ticket(99), () => {}),
  ).rejects.toThrow("does not belong");
  expect(runTransfer).not.toHaveBeenCalled();
});
it("accepts jobs after a StrictMode setup cycle and ignores results after actual disposal", async () => {
  let finish!: (result: TransferOutcome) => void;
  const binding = bindSession(
    {
      ...previewServices,
      chooseUploads: async () => [ticket(4)],
      runTransfer: () => new Promise((resolve) => (finish = resolve)),
      cancelTransfer: async () => {},
    },
    session,
  );
  const queue = new TransferQueue(binding.services);
  queue.dispose();
  queue.activate();
  queue.enqueue(await binding.services.chooseUploads("parent"));
  expect(queue.snapshot()[0].status).toBe("running");
  queue.dispose();
  finish({ status: "completed", bytes: 64, total: 64 });
  await Promise.resolve();
  await Promise.resolve();
  expect(queue.snapshot()[0].status).toBe("running");
});

it("keeps failed cancellations owned and busy without starting an unwanted queued upload", async () => {
  const done = new Map<number, (outcome: TransferOutcome) => void>();
  const runTransfer = vi.fn(
    (_: number, id: number) =>
      new Promise<TransferOutcome>((resolve) => done.set(id, resolve)),
  );
  const cancelTransfer = vi.fn(async (): Promise<void> => {
    throw new Error("IPC unavailable");
  });
  const binding = bindSession(
    {
      ...previewServices,
      chooseUploads: async () => [ticket(1), ticket(2), ticket(3)],
      runTransfer,
      cancelTransfer,
    },
    session,
  );
  const queue = new TransferQueue(binding.services);
  queue.enqueue(await binding.services.chooseUploads("parent"));
  await queue.cancel(1);
  await queue.cancel(2);
  expect(queue.snapshot().map((row) => row.status)).toEqual([
    "running",
    "cancel-failed",
    "queued",
  ]);
  expect(queue.snapshot().every(pendingTransfer)).toBe(true);
  queue.clearFinished();
  expect(queue.snapshot()).toHaveLength(3);
  done.get(1)!({ status: "completed", bytes: 64, total: 64 });
  await vi.waitFor(() =>
    expect(runTransfer.mock.calls.map((call) => call[1])).toEqual([1, 3]),
  );
  cancelTransfer.mockImplementation(async () => {});
  await queue.cancel(2);
  expect(queue.snapshot()[1].status).toBe("canceled");
  done.get(3)!({ status: "completed", bytes: 64, total: 64 });
  await vi.waitFor(() =>
    expect(queue.snapshot().some(pendingTransfer)).toBe(false),
  );
});

it("does not replace a confirmed completion with a late cancellation error", async () => {
  let finish!: (result: TransferOutcome) => void;
  let rejectCancel!: (error: Error) => void;
  const binding = bindSession(
    {
      ...previewServices,
      chooseUploads: async () => [ticket(1)],
      runTransfer: () => new Promise((resolve) => (finish = resolve)),
      cancelTransfer: () =>
        new Promise<void>((_, reject) => (rejectCancel = reject)),
    },
    session,
  );
  const queue = new TransferQueue(binding.services);
  queue.enqueue(await binding.services.chooseUploads("parent"));
  const cancellation = queue.cancel(1);
  finish({ status: "completed", bytes: 64, total: 64 });
  await vi.waitFor(() => expect(queue.snapshot()[0].status).toBe("completed"));
  rejectCancel(new Error("late cancellation failure"));
  await cancellation;
  expect(queue.snapshot()[0].status).toBe("completed");
});
it("asks once per conflict and passes reviewed replacements to the backend", async () => {
  const conflicts = ["one", "two"].map((name) => ({
    sourceKind: "file",
    destination: {
      name,
      path: `remote@${name}`,
      revision: `rev-${name}`,
      kind: "file" as const,
      size: 1,
      modified: null,
    },
  }));
  const runTransfer = vi.fn(
    async (
      _ticket: TransferTicket,
      _progress: (event: never) => void,
      _policy?: TransferPolicy,
    ) => ({
      status: "completed" as const,
      bytes: 64,
      total: 64,
    }),
  );
  const services = {
    transferConflicts: async () => ({ conflicts, canReplace: true }),
    runTransfer,
    cancelTransfer: vi.fn(async () => {}),
  } as unknown as SessionServices;
  const choices = vi.fn(async () => "replace-all" as const);
  const queue = new TransferQueue(services, undefined, choices);
  queue.enqueue([ticket(1)]);
  await vi.waitFor(() => expect(queue.snapshot()[0].status).toBe("completed"));
  expect(choices).toHaveBeenCalledTimes(1);
  expect(runTransfer.mock.calls[0][2]).toEqual({
    replace: [
      { path: "remote@one", revision: "rev-one" },
      { path: "remote@two", revision: "rev-two" },
    ],
    skip: [],
  });
});
it("cancels a reviewed conflict without starting a transfer", async () => {
  const runTransfer = vi.fn();
  const cancelTransfer = vi.fn(async () => {});
  const services = {
    transferConflicts: async () => ({
      canReplace: true,
      conflicts: [
        {
          sourceKind: "file",
          destination: {
            name: "one",
            path: "remote@one",
            revision: "rev-one",
            kind: "file",
            size: 1,
            modified: null,
          },
        },
      ],
    }),
    runTransfer,
    cancelTransfer,
  } as unknown as SessionServices;
  const queue = new TransferQueue(services, undefined, async () => "cancel");
  queue.enqueue([ticket(1)]);
  await vi.waitFor(() => expect(queue.snapshot()[0].status).toBe("canceled"));
  expect(cancelTransfer).toHaveBeenCalledWith(1);
  expect(runTransfer).not.toHaveBeenCalled();
});
it("does not open a conflict prompt after cancellation during inspection", async () => {
  let finishReview!: (value: TransferConflictReview) => void;
  const transferConflicts = vi.fn(
    () =>
      new Promise<TransferConflictReview>((resolve) => {
        finishReview = resolve;
      }),
  );
  const runTransfer = vi.fn();
  const cancelTransfer = vi.fn(async () => {});
  const resolveConflict = vi.fn(async () => "replace" as const);
  const services = {
    transferConflicts,
    runTransfer,
    cancelTransfer,
  } as unknown as SessionServices;
  const queue = new TransferQueue(services, undefined, resolveConflict);
  queue.enqueue([ticket(1)]);
  await vi.waitFor(() => expect(transferConflicts).toHaveBeenCalledOnce());
  await queue.cancel(1);
  finishReview({
    canReplace: true,
    conflicts: [
      {
        sourceKind: "file",
        destination: {
          name: "one",
          path: "remote@one",
          revision: "rev-one",
          kind: "file",
          size: 1,
          modified: null,
        },
      },
    ],
  });
  await vi.waitFor(() => expect(queue.snapshot()[0].status).toBe("canceled"));
  expect(resolveConflict).not.toHaveBeenCalled();
  expect(runTransfer).not.toHaveBeenCalled();
  expect(cancelTransfer).toHaveBeenCalledWith(1);
});
