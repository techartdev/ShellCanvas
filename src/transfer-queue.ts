// SPDX-License-Identifier: MPL-2.0
import type {
  SessionServices,
  TransferOutcome,
  TransferProgress,
  TransferTicket,
  TransferPolicy,
  TransferConflictReview,
} from "./sdk";
import { TransferCleanupError } from "./transfer-errors";
export interface TransferRow extends TransferTicket {
  status:
    | "queued"
    | "running"
    | "reviewing"
    | "canceling"
    | "cancel-failed"
    | TransferOutcome["status"];
  items?: number;
  bytes: number;
  total: number;
  phase: TransferProgress["phase"];
  message?: string | null;
  path?: string | null;
}
export const pendingTransfer = (row: TransferRow) =>
  ["queued", "running", "reviewing", "canceling", "cancel-failed"].includes(
    row.status,
  );
export type ConflictDecision = "replace" | "replace-all" | "cancel";
export type ConflictResolver = (
  conflict: TransferConflictReview["conflicts"][number],
  remaining: number,
  signal: AbortSignal,
) => Promise<ConflictDecision>;
/** One stream per Files window; the native scheduler also caps cross-window work. */
export class TransferQueue {
  private rows: TransferRow[] = [];
  private listeners = new Set<() => void>();
  private running: number | null = null;
  private disposed = false;
  private reviewAbort: AbortController | null = null;
  constructor(
    private services: SessionServices,
    private reportError: (message: string) => void = console.warn,
    private resolveConflict?: ConflictResolver,
  ) {}
  activate() {
    this.disposed = false;
  }
  snapshot = () => this.rows;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish() {
    this.listeners.forEach((listener) => listener());
  }
  private update(id: number, patch: Partial<TransferRow>) {
    if (this.disposed) return;
    this.rows = this.rows.map((row) =>
      row.id === id ? { ...row, ...patch } : row,
    );
    this.publish();
  }
  enqueue(tickets: TransferTicket[]) {
    if (this.disposed) {
      for (const ticket of tickets)
        void this.services
          .cancelTransfer(ticket.id)
          .catch((error) =>
            this.reportError(`Transfer cleanup failed: ${error}`),
          );
      return;
    }
    this.rows = [
      ...this.rows.filter(pendingTransfer),
      ...this.rows.filter((row) => !pendingTransfer(row)).slice(-50),
      ...tickets.map((ticket) => ({
        ...ticket,
        status: "queued" as const,
        bytes: 0,
        total: ticket.size,
        phase: "preparing" as const,
      })),
    ];
    this.publish();
    void this.pump();
  }
  private async pump() {
    if (this.disposed || this.running !== null) return;
    const row = this.rows.find((row) => row.status === "queued");
    if (!row) return;
    this.running = row.id;
    this.update(row.id, { status: "running" });
    let dispatched = false;
    const reviewAbort = new AbortController();
    this.reviewAbort = reviewAbort;
    try {
      let policy: TransferPolicy | undefined;
      if (
        (row.direction === "upload" || row.direction === "copy") &&
        this.services.transferConflicts
      ) {
        const review = await this.services.transferConflicts(row);
        if (reviewAbort.signal.aborted) {
          await this.services.cancelTransfer(row.id);
          this.update(row.id, { status: "canceled", message: null });
          return;
        }
        if (review.conflicts.length) {
          if (
            !review.canReplace ||
            !this.resolveConflict ||
            review.conflicts.some(
              ({ destination, sourceKind }) =>
                destination.kind !== sourceKind ||
                !["file", "directory"].includes(sourceKind),
            )
          )
            throw new Error(
              "Safe replacement is unavailable for one or more destination items. Nothing was replaced.",
            );
          this.update(row.id, { status: "reviewing" });
          const replace: TransferPolicy["replace"] = [];
          for (let i = 0; i < review.conflicts.length; i++) {
            if (reviewAbort.signal.aborted) break;
            const decision = await this.resolveConflict(
              review.conflicts[i],
              review.conflicts.length - i,
              reviewAbort.signal,
            );
            if (decision === "cancel") break;
            const selected =
              decision === "replace-all"
                ? review.conflicts.slice(i)
                : [review.conflicts[i]];
            replace.push(
              ...selected.map(({ destination }) => ({
                path: destination.path,
                revision: destination.revision!,
              })),
            );
            if (decision === "replace-all") break;
          }
          if (
            reviewAbort.signal.aborted ||
            replace.length !== review.conflicts.length
          ) {
            await this.services.cancelTransfer(row.id);
            this.update(row.id, { status: "canceled", message: null });
            return;
          }
          policy = { replace, skip: [] };
          this.update(row.id, { status: "running" });
        }
      }
      this.reviewAbort = null;
      dispatched = true;
      const result = await this.services.runTransfer(
        row,
        (event) => this.update(row.id, event),
        policy,
      );
      this.update(row.id, result);
    } catch (error) {
      if (!dispatched) {
        try {
          await this.services.cancelTransfer(row.id);
          if (reviewAbort.signal.aborted) {
            this.update(row.id, { status: "canceled", message: null });
            return;
          }
        } catch (cleanup) {
          error = new TransferCleanupError(
            `${error}; transfer cleanup failed: ${cleanup}`,
          );
        }
      }
      this.update(row.id, {
        status:
          error instanceof TransferCleanupError ? "cancel-failed" : "failed",
        message: String(error),
      });
    } finally {
      this.reviewAbort = null;
      this.running = null;
      void this.pump();
    }
  }
  async cancel(id: number) {
    const row = this.rows.find((row) => row.id === id);
    if (!row || !pendingTransfer(row) || row.status === "canceling") return;
    const queued = this.running !== id;
    if (!queued && this.reviewAbort) {
      this.reviewAbort?.abort();
      this.update(id, { status: "canceling", message: null });
      return;
    }
    // Keep ownership and close guards until native cancellation is acknowledged.
    // A failed queued cancellation must never start that unwanted upload later.
    this.update(id, { status: "canceling", message: null });
    try {
      await this.services.cancelTransfer(id);
      if (queued) this.update(id, { status: "canceled" });
    } catch (error) {
      const current = this.rows.find((item) => item.id === id);
      if (current && pendingTransfer(current))
        this.update(id, {
          status: queued ? "cancel-failed" : "running",
          message: `Cancellation failed: ${error}. Try canceling again.`,
        });
    }
  }
  clearFinished() {
    this.rows = this.rows.filter(pendingTransfer);
    this.publish();
  }
  dispose() {
    this.disposed = true;
    this.reviewAbort?.abort();
    for (const row of this.rows.filter(pendingTransfer))
      void this.services
        .cancelTransfer(row.id)
        .catch((error) =>
          this.reportError(`Transfer cleanup failed: ${error}`),
        );
  }
}
