// SPDX-License-Identifier: MPL-2.0
import {
  transferCapability,
  type Capability,
  type SessionServices,
  type TransferTicket,
} from "../sdk";
import type {
  TransferProgress,
  TransferResult,
  TransferSnapshot,
} from "../../packages/app-sdk/src/transfer-client";
import { RpcError, type Json, type RpcMethod } from "./rpc";
import { TransferCleanupError } from "../transfer-errors";

export interface AppTransferSource {
  binding: string;
  services: Pick<
    SessionServices,
    | "chooseUploads"
    | "chooseDownload"
    | "chooseDownloads"
    | "prepareCopy"
    | "runTransfer"
    | "cancelTransfer"
  > &
    Partial<
      Pick<
        SessionServices,
        | "pasteSystemFiles"
        | "systemFileClipboard"
        | "copyToSystem"
        | "cancelClipboardPreparation"
        | "inspectSystemFiles"
        | "pasteCopiedFiles"
        | "pasteMovedFiles"
      >
    >;
}
export type AppTransferSourceGetter = () => AppTransferSource | undefined;
interface Preparation {
  id: string;
  source: AppTransferSource;
  canceled: boolean;
  pending: boolean;
  jobs: Set<Job>;
}
interface Job {
  id: string;
  source: AppTransferSource;
  ticket: TransferTicket;
  preparation: Preparation;
  snapshot: TransferSnapshot;
  running?: Promise<TransferResult>;
  canceling?: Promise<void>;
  watching: boolean;
  wake?: () => void;
  closed: boolean;
  abandoned: boolean;
  cleanupResult?: TransferResult;
}
function parameters(value: Json, fields: string[]) {
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
      "Supply the documented transfer parameters only.",
    );
  return value as { id: string; [key: string]: Json };
}
function message(error: unknown) {
  return (
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Transfer operation failed."
  ).slice(0, 4096);
}
function failure(error: unknown) {
  return error instanceof RpcError
    ? error
    : new RpcError("failed", message(error));
}

/** Per-window ticket owner. All file bytes remain in the native transfer engine. */
export class AppTransfers {
  private preparations = new Map<string, Preparation>();
  private jobs = new Map<string, Job>();
  private closed = false;
  private lastBusy = false;
  constructor(
    private source: AppTransferSourceGetter,
    private available: (capability: Capability) => boolean,
    private busyChanged: (busy: boolean) => void = () => {},
    private reportError: (message: string) => void = console.warn,
  ) {}
  private busy() {
    const busy =
      [...this.preparations.values()].some((p) => p.pending) ||
      [...this.jobs.values()].some((job) => !job.snapshot.result);
    if (busy !== this.lastBusy) {
      this.lastBusy = busy;
      this.busyChanged(busy);
    }
  }
  private same(source: AppTransferSource) {
    const current = this.source();
    return (
      !this.closed &&
      current?.binding === source.binding &&
      current.services === source.services
    );
  }
  private update(job: Job, patch: Partial<TransferSnapshot>) {
    job.snapshot = {
      ...job.snapshot,
      ...patch,
      revision: job.snapshot.revision + 1,
    };
    job.wake?.();
    this.busy();
  }
  private find(id: string) {
    const job = this.jobs.get(id);
    if (!job || job.closed)
      throw new RpcError(
        "closed",
        "Transfer handle is closed or belongs to another window.",
      );
    return job;
  }
  private forget(job: Job) {
    job.closed = true;
    job.wake?.();
    if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
    job.preparation.jobs.delete(job);
    if (
      !job.preparation.pending &&
      !job.preparation.jobs.size &&
      this.preparations.get(job.preparation.id) === job.preparation
    )
      this.preparations.delete(job.preparation.id);
    this.busy();
  }
  private cancel(job: Job): Promise<void> {
    if (job.snapshot.result) return Promise.resolve();
    if (job.canceling) return job.canceling;
    this.update(job, { state: "canceling", cancellationError: undefined });
    job.canceling = job.source.services
      .cancelTransfer(job.ticket.id)
      .then(
        () => {
          if (job.cleanupResult) {
            this.update(job, {
              state: job.cleanupResult.status,
              result: job.cleanupResult,
              cancellationError: undefined,
            });
            job.cleanupResult = undefined;
          } else if (!job.running && !job.snapshot.result)
            this.update(job, {
              state: "canceled",
              result: { status: "canceled", bytes: 0, total: job.ticket.size },
            });
        },
        (error) => {
          if (!job.snapshot.result)
            this.update(job, {
              state: "cancel-failed",
              cancellationError: message(error),
            });
          throw failure(error);
        },
      )
      .finally(() => {
        job.canceling = undefined;
      });
    return job.canceling;
  }
  private async release(job: Job) {
    await this.cancel(job);
    if (job.running) await job.running;
    // A blocked start can discover failed cleanup after the initial concurrent
    // cancellation settled. Release only after that retained reservation clears.
    if (job.cleanupResult) await this.cancel(job);
    this.forget(job);
  }
  private abandon(job: Job) {
    job.abandoned = true;
    void this.release(job).catch((error) =>
      this.reportError(`Transfer cleanup failed: ${message(error)}`),
    );
  }
  /** Retry only failed cleanup, including tickets an app never received. */
  async retryCleanup() {
    await Promise.all(
      [...this.jobs.values()]
        .filter(
          (job) => job.abandoned || job.snapshot.state === "cancel-failed",
        )
        .map((job) => (job.abandoned ? this.release(job) : this.cancel(job))),
    );
  }
  close() {
    this.closed = true;
    for (const preparation of this.preparations.values())
      preparation.canceled = true;
    for (const job of this.jobs.values()) this.abandon(job);
  }
  refresh() {
    for (const preparation of this.preparations.values())
      if (!this.same(preparation.source)) preparation.canceled = true;
    for (const job of this.jobs.values())
      if (
        !this.same(job.source) ||
        !this.available(transferCapability(job.ticket.direction))
      )
        void this.cancel(job).catch((error) =>
          this.reportError(`Transfer cancellation failed: ${message(error)}`),
        );
  }
  private async run(job: Job): Promise<TransferResult> {
    if (job.snapshot.result) return job.snapshot.result;
    if (job.running) return job.running;
    if (job.snapshot.state !== "queued")
      throw new RpcError(
        "busy",
        "Resolve transfer cancellation before starting it.",
      );
    if (!this.same(job.source))
      throw new RpcError(
        "closed",
        "Transfer belongs to a previous connection.",
      );
    if (!this.available(transferCapability(job.ticket.direction)))
      throw new RpcError(
        "unavailable",
        "This transfer service is unavailable.",
      );
    this.update(job, { state: "running" });
    job.running = (async () => {
      try {
        const outcome = await job.source.services.runTransfer(
          { ...job.ticket },
          (event) => {
            if (job.snapshot.result) return;
            const progress: TransferProgress = {
              bytes: event.bytes,
              total: event.total,
              phase: event.phase,
              ...(event.items === undefined ? {} : { items: event.items }),
            };
            this.update(job, { progress });
          },
        );
        const result: TransferResult = {
          status: outcome.status,
          bytes: outcome.bytes,
          total: outcome.total,
          ...(outcome.message
            ? { message: outcome.message.slice(0, 4096) }
            : {}),
          ...(outcome.path && job.ticket.direction !== "download"
            ? {
                destination: {
                  binding: job.source.binding,
                  path: outcome.path,
                },
              }
            : {}),
        };
        this.update(job, { state: result.status, result });
        return result;
      } catch (error) {
        const result: TransferResult = {
          status: "failed",
          bytes: job.snapshot.progress.bytes,
          total: job.snapshot.progress.total,
          message: message(error),
        };
        if (error instanceof TransferCleanupError) {
          job.cleanupResult = result;
          this.update(job, {
            state: "cancel-failed",
            cancellationError: result.message ?? "Move cleanup failed",
          });
        } else this.update(job, { state: "failed", result });
        return result;
      }
    })();
    return job.running;
  }
  methods(): ReadonlyMap<string, RpcMethod> {
    const prepare = (
      name: string,
      capability: Capability,
      fields: string[],
      create: (
        source: AppTransferSource,
        p: { [key: string]: Json },
      ) => Promise<TransferTicket[]>,
      folder = false,
      extraGrants: string[] = [],
      supported: () => boolean = () => true,
    ): [string, RpcMethod] => [
      `system.transfers.${name}`,
      {
        grants: [capability, ...extraGrants],
        available: () =>
          this.available(capability) &&
          supported() &&
          (!folder || this.available("files.folders")),
        invoke: async (value, signal) => {
          const p = parameters(value, ["id", "binding", ...fields]);
          if (
            typeof p.binding !== "string" ||
            fields
              .filter((field) => field !== "entries" && field !== "sequence")
              .some((field) => typeof p[field] !== "string")
          )
            throw new RpcError(
              "invalid",
              "Supply opaque locations and revisions.",
            );
          if (
            fields.includes("sequence") &&
            (typeof p.sequence !== "number" ||
              !Number.isInteger(p.sequence) ||
              p.sequence < 0 ||
              p.sequence > 0xffffffff)
          )
            throw new RpcError(
              "invalid",
              "Supply the captured clipboard sequence.",
            );
          if (this.closed)
            throw new RpcError("closed", "Transfer owner closed.");
          if (signal.aborted)
            throw new RpcError("aborted", "Transfer preparation canceled.");
          if (
            !this.available(capability) ||
            !supported() ||
            (folder && !this.available("files.folders"))
          )
            throw new RpcError(
              "unavailable",
              "This transfer service is unavailable.",
            );
          const source = this.source();
          if (!source)
            throw new RpcError(
              "unavailable",
              "No file source in this workspace.",
            );
          if (source.binding !== p.binding)
            throw new RpcError("closed", "The workspace binding has changed.");
          if (
            this.preparations.has(p.id) ||
            this.preparations.size >= 32 ||
            this.jobs.size >= 32 ||
            [...this.preparations.values()].some((item) => item.pending)
          )
            throw new RpcError(
              "busy",
              "Finish the active chooser or release existing transfers first.",
            );
          const preparation: Preparation = {
            id: p.id,
            source,
            canceled: false,
            pending: true,
            jobs: new Set(),
          };
          this.preparations.set(p.id, preparation);
          this.busy();
          const abort = () => {
            preparation.canceled = true;
            for (const job of preparation.jobs) this.abandon(job);
          };
          signal.addEventListener("abort", abort, { once: true });
          try {
            const tickets = await create(source, p);
            for (const [index, ticket] of tickets.entries()) {
              const job: Job = {
                id: `${p.id}-${index}`,
                source,
                ticket: { ...ticket },
                preparation,
                closed: false,
                abandoned: false,
                watching: false,
                snapshot: {
                  revision: 0,
                  state: "queued",
                  progress: {
                    bytes: 0,
                    total: ticket.size,
                    phase: "preparing",
                  },
                },
              };
              preparation.jobs.add(job);
              this.jobs.set(job.id, job);
            }
            if (
              preparation.canceled ||
              !this.same(source) ||
              !this.available(capability) ||
              (folder && !this.available("files.folders")) ||
              tickets.some(
                (ticket) => transferCapability(ticket.direction) !== capability,
              ) ||
              this.jobs.size > 32
            ) {
              for (const job of preparation.jobs) this.abandon(job);
              throw new RpcError(
                preparation.canceled
                  ? "aborted"
                  : this.jobs.size > 32
                    ? "busy"
                    : "closed",
                "Prepared transfers were canceled or their source changed.",
              );
            }
            return [...preparation.jobs].map((job) => ({
              id: job.id,
              binding: source.binding,
              name: job.ticket.name,
              size: job.ticket.size,
              direction: job.ticket.direction,
            }));
          } catch (error) {
            throw failure(error);
          } finally {
            signal.removeEventListener("abort", abort);
            preparation.pending = false;
            if (!preparation.jobs.size) this.preparations.delete(p.id);
            this.busy();
          }
        },
      },
    ];
    const method = (invoke: RpcMethod["invoke"]): RpcMethod => ({
      grants: [],
      invoke,
    });
    return new Map([
      [
        "system.transfers.clipboardInspect",
        {
          grants: ["system.clipboard.files.read"],
          available: () => this.source()?.services.systemFileClipboard === true,
          invoke: async (value: Json, signal: AbortSignal) => {
            if (
              !value ||
              typeof value !== "object" ||
              Array.isArray(value) ||
              Object.keys(value).length !== 1 ||
              typeof value.binding !== "string"
            )
              throw new RpcError(
                "invalid",
                "Supply the accepted workspace binding.",
              );
            const captured = this.source();
            if (!captured || captured.services.systemFileClipboard !== true)
              throw new RpcError(
                "unavailable",
                "Native file clipboard is unavailable.",
              );
            if (this.closed || captured.binding !== value.binding)
              throw new RpcError("closed", "Workspace binding changed.");
            if (signal.aborted)
              throw new RpcError("aborted", "Clipboard inspection canceled.");
            const state = captured.services.inspectSystemFiles
              ? await captured.services.inspectSystemFiles()
              : { kind: "local", sequence: null, intent: "copy" as const };
            if (!this.same(captured) || signal.aborted)
              throw new RpcError(
                "closed",
                "Workspace changed during clipboard inspection.",
              );
            if (
              !["remote", "local", "empty"].includes(state.kind) ||
              (state.intent !== undefined &&
                !["copy", "move"].includes(state.intent)) ||
              (state.sequence !== null &&
                (!Number.isInteger(state.sequence) ||
                  state.sequence < 0 ||
                  state.sequence > 0xffffffff))
            )
              throw new RpcError("failed", "Invalid clipboard snapshot.");
            return {
              kind: state.kind,
              sequence: state.sequence,
              ...(state.intent ? { intent: state.intent } : {}),
            };
          },
        },
      ],
      prepare(
        "clipboardMoveSnapshot",
        "files.move",
        ["parent", "sequence"],
        (source, p) =>
          source.services.pasteMovedFiles!(
            p.parent as string,
            p.sequence as number,
          ),
        false,
        ["system.clipboard.files.read"],
        () =>
          this.source()?.services.systemFileClipboard === true &&
          typeof this.source()?.services.pasteMovedFiles === "function",
      ),
      prepare(
        "clipboardCopySnapshot",
        "files.copy",
        ["parent", "sequence"],
        (source, p) =>
          source.services.pasteCopiedFiles!(
            p.parent as string,
            p.sequence as number,
          ),
        false,
        ["system.clipboard.files.read"],
        () =>
          this.source()?.services.systemFileClipboard === true &&
          typeof this.source()?.services.pasteCopiedFiles === "function",
      ),
      prepare(
        "clipboardPasteSnapshot",
        "files.upload",
        ["parent", "sequence"],
        async (source, p) =>
          (await source.services.pasteSystemFiles!(
            p.parent as string,
            p.sequence as number,
          )) ?? [],
        false,
        ["system.clipboard.files.read"],
        () =>
          this.source()?.services.systemFileClipboard === true &&
          typeof this.source()?.services.pasteSystemFiles === "function",
      ),
      prepare(
        "clipboardPaste",
        "files.upload",
        ["parent"],
        async (source, p) =>
          (await source.services.pasteSystemFiles!(p.parent as string)) ?? [],
        false,
        ["system.clipboard.files.read"],
        () =>
          this.source()?.services.systemFileClipboard === true &&
          typeof this.source()?.services.pasteSystemFiles === "function",
      ),
      prepare("upload", "files.upload", ["parent"], (s, p) =>
        s.services.chooseUploads(p.parent as string),
      ),
      prepare(
        "uploadFolder",
        "files.upload",
        ["parent"],
        (s, p) => s.services.chooseUploads(p.parent as string, true),
        true,
      ),
      prepare(
        "download",
        "files.download",
        ["path", "revision"],
        async (s, p) => {
          const ticket = await s.services.chooseDownload(
            p.path as string,
            p.revision as string,
          );
          return ticket ? [ticket] : [];
        },
      ),
      prepare("downloadMany", "files.download", ["entries"], (s, p) => {
        if (
          !Array.isArray(p.entries) ||
          !p.entries.length ||
          p.entries.some(
            (item) =>
              !item ||
              typeof item !== "object" ||
              Array.isArray(item) ||
              Object.keys(item).length !== 3 ||
              item.binding !== p.binding ||
              typeof item.path !== "string" ||
              typeof item.revision !== "string",
          )
        )
          throw new RpcError(
            "invalid",
            "Download entries must share one accepted binding and include their revisions.",
          );
        return s.services.chooseDownloads(
          p.entries.map((entry) => {
            const item = entry as { path: string; revision: string };
            return { path: item.path, revision: item.revision };
          }),
        );
      }),
      prepare(
        "copy",
        "files.copy",
        ["path", "revision", "parent", "parentBinding"],
        async (s, p) => {
          if (p.parentBinding !== p.binding)
            throw new RpcError(
              "invalid",
              "Copy source and destination must share the same binding.",
            );
          return [
            await s.services.prepareCopy(
              p.path as string,
              p.revision as string,
              p.parent as string,
            ),
          ];
        },
      ),
      [
        "system.transfers.run",
        method(
          (value) =>
            this.run(
              this.find(parameters(value, ["id"]).id),
            ) as unknown as Promise<Json>,
        ),
      ],
      [
        "system.transfers.status",
        method(async (value, signal) => {
          const p = parameters(value, ["id", "after"]);
          const job = this.find(p.id);
          if (
            p.after !== null &&
            (!Number.isSafeInteger(p.after) ||
              (p.after as number) < 0 ||
              (p.after as number) > job.snapshot.revision)
          )
            throw new RpcError(
              "invalid",
              "Supply this transfer's revision or null.",
            );
          if (signal.aborted)
            throw new RpcError("aborted", "Progress watching stopped.");
          if (p.after !== job.snapshot.revision || job.snapshot.result)
            return JSON.parse(JSON.stringify(job.snapshot)) as Json;
          if (job.watching)
            throw new RpcError(
              "busy",
              "Only one progress watcher may wait per transfer.",
            );
          job.watching = true;
          const abort = () => job.wake?.();
          signal.addEventListener("abort", abort, { once: true });
          try {
            while (
              p.after === job.snapshot.revision &&
              !job.snapshot.result &&
              !job.closed &&
              !signal.aborted
            )
              await new Promise<void>((resolve) => {
                job.wake = resolve;
              });
            if (signal.aborted)
              throw new RpcError(
                "aborted",
                "Progress watching stopped; the transfer remains owned.",
              );
            if (job.closed)
              throw new RpcError("closed", "Transfer handle was released.");
            this.find(p.id);
            return JSON.parse(JSON.stringify(job.snapshot)) as Json;
          } finally {
            job.watching = false;
            job.wake = undefined;
            signal.removeEventListener("abort", abort);
          }
        }),
      ],
      [
        "system.transfers.cancel",
        method(async (value) => {
          await this.cancel(this.find(parameters(value, ["id"]).id));
          return null;
        }),
      ],
      [
        "system.transfers.close",
        method(async (value) => {
          const id = parameters(value, ["id"]).id;
          const job = this.jobs.get(id);
          if (job) await this.release(job);
          return null;
        }),
      ],
      [
        "system.transfers.cancelPreparation",
        method(async (value) => {
          const preparation = this.preparations.get(
            parameters(value, ["id"]).id,
          );
          if (preparation) {
            preparation.canceled = true;
            await Promise.all(
              [...preparation.jobs].map((job) => this.release(job)),
            );
          }
          return null;
        }),
      ],
    ]);
  }
}
