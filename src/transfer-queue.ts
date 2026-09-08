// SPDX-License-Identifier: MPL-2.0
import type {
  SessionServices,
  TransferOutcome,
  TransferProgress,
  TransferTicket,
} from "./sdk";
export interface TransferRow extends TransferTicket {
  status:
    | "queued"
    | "running"
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
  ["queued", "running", "canceling", "cancel-failed"].includes(row.status);
/** One stream per Files window; the native scheduler also caps cross-window work. */
export class TransferQueue {
  private rows: TransferRow[] = [];
  private listeners = new Set<() => void>();
  private running: number | null = null;
  private disposed = false;
  constructor(
    private services: SessionServices,
    private reportError: (message: string) => void = console.warn,
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
    try {
      const result = await this.services.runTransfer(row, (event) =>
        this.update(row.id, event),
      );
      this.update(row.id, result);
    } catch (error) {
      this.update(row.id, { status: "failed", message: String(error) });
    } finally {
      this.running = null;
      void this.pump();
    }
  }
  async cancel(id: number) {
    const row = this.rows.find((row) => row.id === id);
    if (!row || !pendingTransfer(row) || row.status === "canceling") return;
    const queued = this.running !== id;
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
    for (const row of this.rows.filter(pendingTransfer))
      void this.services
        .cancelTransfer(row.id)
        .catch((error) =>
          this.reportError(`Transfer cleanup failed: ${error}`),
        );
  }
}
