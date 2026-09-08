// SPDX-License-Identifier: MPL-2.0
import type { SessionServices, TerminalEvent, TerminalSession } from "../sdk";
import { RpcError, type Json, type RpcMethod } from "./rpc";

export interface AppConsoleSource {
  binding: string;
  services: Pick<SessionServices, "terminal">;
}
export type AppConsoleSourceGetter = () => AppConsoleSource | undefined;
interface ConsoleSlot {
  id: string;
  source: AppConsoleSource;
  opening: Promise<TerminalSession>;
  handle?: TerminalSession;
  retired: boolean;
  ended: boolean;
  error?: RpcError;
  chunk?: { bytes: number[]; consumed(): void };
  wake?: () => void;
  reading: boolean;
  writing: boolean;
  resizing: boolean;
  operations: number;
  cleaned: boolean;
  closing?: Promise<void>;
  providerClose?: Promise<void>;
}
function args(value: Json, fields: string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(value.id)
  )
    throw new RpcError(
      "invalid",
      "Supply the documented console parameters only.",
    );
  return value as { id: string; [key: string]: Json };
}
function dimensions(p: { cols: Json; rows: Json }) {
  if (
    !Number.isInteger(p.cols) ||
    !Number.isInteger(p.rows) ||
    (p.cols as number) < 2 ||
    (p.cols as number) > 500 ||
    (p.rows as number) < 2 ||
    (p.rows as number) > 300
  )
    throw new RpcError(
      "invalid",
      "Console dimensions must be 2–500 columns and 2–300 rows.",
    );
  return { cols: p.cols as number, rows: p.rows as number };
}
function failure(error: unknown) {
  return error instanceof RpcError
    ? error
    : new RpcError(
        "failed",
        (error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Console operation failed."
        ).slice(0, 4096),
      );
}

/** A window owns its consoles, including pending opens and unfinished cleanup. */
export class AppConsoles {
  private slots = new Map<string, ConsoleSlot>();
  private resources = new Set<ConsoleSlot>();
  private closed = false;
  constructor(
    private source: AppConsoleSourceGetter,
    private reportError: (message: string) => void = console.warn,
  ) {}
  private current(slot: ConsoleSlot) {
    const source = this.source();
    return (
      !this.closed &&
      !slot.retired &&
      source?.binding === slot.source.binding &&
      source.services === slot.source.services
    );
  }
  private retire(slot: ConsoleSlot): Promise<void> {
    if (slot.closing) return slot.closing;
    slot.retired = true;
    if (this.slots.get(slot.id) === slot) this.slots.delete(slot.id);
    slot.chunk?.consumed();
    slot.chunk = undefined;
    slot.wake?.();
    slot.closing = this.closeProvider(slot).then(() => {
      slot.cleaned = true;
      this.release(slot);
    });
    return slot.closing;
  }
  private closeProvider(slot: ConsoleSlot) {
    return (slot.providerClose ??= slot.opening.then(
      (handle) => handle.close(),
      () => {},
    ));
  }
  private abandon(slot: ConsoleSlot) {
    void this.retire(slot).catch((error) =>
      this.reportError(`Console cleanup failed: ${failure(error).message}`),
    );
  }
  private release(slot: ConsoleSlot) {
    if (slot.retired && slot.cleaned && slot.operations === 0)
      this.resources.delete(slot);
  }
  close() {
    this.closed = true;
    for (const slot of this.slots.values()) this.abandon(slot);
  }
  refresh(available = true) {
    for (const slot of this.slots.values())
      if (!available || !this.current(slot)) this.abandon(slot);
  }
  private find(id: string) {
    const slot = this.slots.get(id);
    if (!slot || !this.current(slot)) {
      if (slot) this.abandon(slot);
      throw new RpcError(
        "closed",
        "Console is closed or belongs to a previous connection.",
      );
    }
    return slot;
  }
  private event(slot: ConsoleSlot, event: TerminalEvent): void | Promise<void> {
    if (slot.retired || slot.ended) return;
    if (event.type === "output") {
      if (
        slot.chunk ||
        !event.data.length ||
        event.data.length > 65536 ||
        event.data.some((b) => !Number.isInteger(b) || b < 0 || b > 255)
      ) {
        slot.error = new RpcError(
          "failed",
          "Console provider violated output flow control or returned an invalid byte chunk.",
        );
        slot.ended = true;
        slot.wake?.();
        // Keep the explicit failure readable, but stop the provider.
        void this.closeProvider(slot).catch((error) =>
          this.reportError(failure(error).message),
        );
        return;
      }
      return new Promise<void>((consumed) => {
        slot.chunk = { bytes: [...event.data], consumed };
        slot.wake?.();
      });
    }
    if (event.type === "error")
      slot.error = new RpcError("failed", event.data.slice(0, 4096));
    slot.ended = true;
    slot.wake?.();
  }
  private watch(slot: ConsoleSlot, signal: AbortSignal) {
    const abort = () => this.abandon(slot);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return () => signal.removeEventListener("abort", abort);
  }
  methods(): ReadonlyMap<string, RpcMethod> {
    const method = (
      invoke: RpcMethod["invoke"],
      grants = ["system.console"],
    ): RpcMethod => ({ grants, invoke });
    return new Map([
      [
        "system.console.open",
        method(async (value, signal) => {
          const p = args(value, ["id", "binding", "cols", "rows"]);
          const size = dimensions({ cols: p.cols, rows: p.rows });
          if (typeof p.binding !== "string")
            throw new RpcError(
              "invalid",
              "Supply the accepted workspace binding.",
            );
          if (this.closed)
            throw new RpcError("closed", "Console owner closed.");
          if (signal.aborted)
            throw new RpcError("aborted", "Console opening canceled.");
          const source = this.source();
          if (!source)
            throw new RpcError(
              "unavailable",
              "No console source in this workspace.",
            );
          if (p.binding !== source.binding)
            throw new RpcError("closed", "The workspace binding has changed.");
          if (this.slots.has(p.id) || this.resources.size >= 16)
            throw new RpcError(
              "busy",
              "Close an existing console before opening another.",
            );
          const slot: ConsoleSlot = {
            id: p.id,
            source,
            opening: undefined!,
            retired: false,
            ended: false,
            reading: false,
            writing: false,
            resizing: false,
            operations: 0,
            cleaned: false,
          };
          this.slots.set(p.id, slot);
          this.resources.add(slot);
          slot.opening = Promise.resolve().then(() => {
            if (slot.retired)
              throw new RpcError(
                "aborted",
                "Console opening canceled before dispatch.",
              );
            return source.services.terminal(size.cols, size.rows, (event) =>
              this.event(slot, event),
            );
          });
          const stop = this.watch(slot, signal);
          try {
            slot.handle = await slot.opening;
            if (!this.current(slot) || signal.aborted)
              throw new RpcError(
                "closed",
                "Console opened after its owner retired.",
              );
            return {
              binding: source.binding,
              resizable: slot.handle.resizable ?? true,
            };
          } catch (error) {
            this.abandon(slot);
            throw failure(error);
          } finally {
            stop();
          }
        }),
      ],
      [
        "system.console.read",
        method(async (value, signal) => {
          const { id } = args(value, ["id"]);
          const slot = this.find(id);
          if (!slot.handle)
            throw new RpcError("busy", "Console is still opening.");
          if (slot.reading)
            throw new RpcError("busy", "Only one read may wait on a console.");
          slot.reading = true;
          const stop = this.watch(slot, signal);
          try {
            while (!slot.chunk && !slot.ended && !slot.retired)
              await new Promise<void>((resolve) => {
                slot.wake = resolve;
              });
            if (signal.aborted)
              throw new RpcError(
                "aborted",
                "Console read canceled; the console was closed.",
              );
            if (!this.current(slot))
              throw new RpcError(
                "closed",
                "Console owner retired during reading.",
              );
            this.find(id);
            if (slot.chunk) {
              const chunk = slot.chunk;
              slot.chunk = undefined;
              chunk.consumed();
              return { bytes: chunk.bytes };
            }
            if (slot.error) throw slot.error;
            return null;
          } finally {
            slot.reading = false;
            slot.wake = undefined;
            stop();
          }
        }),
      ],
      [
        "system.console.write",
        method(async (value, signal) => {
          const p = args(value, ["id", "bytes"]);
          if (
            !Array.isArray(p.bytes) ||
            p.bytes.length > 65536 ||
            p.bytes.some(
              (b) =>
                typeof b !== "number" ||
                !Number.isInteger(b) ||
                b < 0 ||
                b > 255,
            )
          )
            throw new RpcError("invalid", "Supply at most 64 KiB of bytes.");
          const slot = this.find(p.id);
          if (!slot.handle)
            throw new RpcError("busy", "Console is still opening.");
          if (slot.ended) throw new RpcError("closed", "Console stream ended.");
          if (slot.writing)
            throw new RpcError("busy", "Wait for the current console write.");
          slot.writing = true;
          slot.operations++;
          const stop = this.watch(slot, signal);
          try {
            if (signal.aborted)
              throw new RpcError("aborted", "Console write canceled.");
            await slot.handle.write(Uint8Array.from(p.bytes as number[]));
            if (!this.current(slot))
              throw new RpcError(
                "closed",
                "Console retired during writing; some bytes may have been delivered.",
              );
            return null;
          } catch (error) {
            this.abandon(slot);
            throw failure(error);
          } finally {
            slot.writing = false;
            slot.operations--;
            this.release(slot);
            stop();
          }
        }),
      ],
      [
        "system.console.resize",
        method(async (value, signal) => {
          const p = args(value, ["id", "cols", "rows"]);
          const size = dimensions({ cols: p.cols, rows: p.rows });
          const slot = this.find(p.id);
          if (!slot.handle)
            throw new RpcError("busy", "Console is still opening.");
          if (!slot.handle.resizable && slot.handle.resizable !== undefined)
            throw new RpcError(
              "unavailable",
              "This console has fixed dimensions.",
            );
          if (slot.ended) throw new RpcError("closed", "Console stream ended.");
          if (slot.resizing)
            throw new RpcError("busy", "Wait for the current console resize.");
          slot.resizing = true;
          slot.operations++;
          const stop = this.watch(slot, signal);
          try {
            if (signal.aborted)
              throw new RpcError("aborted", "Console resize canceled.");
            await slot.handle.resize(size.cols, size.rows);
            if (!this.current(slot))
              throw new RpcError("closed", "Console retired during resize.");
            return null;
          } catch (error) {
            throw failure(error);
          } finally {
            slot.resizing = false;
            slot.operations--;
            this.release(slot);
            stop();
          }
        }),
      ],
      [
        "system.console.close",
        method(async (value) => {
          const { id } = args(value, ["id"]);
          const slot = this.slots.get(id);
          if (slot)
            try {
              await this.retire(slot);
            } catch (error) {
              throw failure(error);
            }
          return null;
        }, []),
      ],
    ]);
  }
}
