// SPDX-License-Identifier: MPL-2.0
import type { SessionServices } from "../sdk";
import { RpcError, type Json, type RpcMethod } from "./rpc";

export interface AppFileClipboardSource {
  binding: string;
  services: Partial<
    Pick<
      SessionServices,
      | "copyToSystem"
      | "cutToSystem"
      | "cancelClipboardPreparation"
      | "systemFileClipboard"
    >
  >;
}
type Selection = {
  kind: "copy" | "cut";
  id: string;
  source: AppFileClipboardSource;
  entries: { path: string; revision: string }[];
};
type Publication = Selection & {
  nativeId: string;
  canceled: boolean;
  canceling: boolean;
  retryCancel: boolean;
};
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
      "Supply the documented clipboard parameters only.",
    );
  return value as { id: string; [key: string]: Json };
}

/** Stages root references only. Native code discovers folders and streams file contents. */
export class AppFileClipboard {
  private closed = false;
  private staged?: Selection;
  private publishing?: Publication;
  constructor(
    private source: () => AppFileClipboardSource | undefined,
    private available: (kind: Selection["kind"]) => boolean,
    private busyChanged: (busy: boolean) => void = () => {},
  ) {}
  private same(selection: Selection) {
    const current = this.source();
    return (
      !this.closed &&
      current?.binding === selection.source.binding &&
      current.services === selection.source.services
    );
  }
  private supported(kind: Selection["kind"]) {
    const source = this.source();
    return (
      this.available(kind) &&
      source?.services.systemFileClipboard === true &&
      typeof source.services[
        kind === "cut" ? "cutToSystem" : "copyToSystem"
      ] === "function" &&
      typeof source.services.cancelClipboardPreparation === "function"
    );
  }
  private cancel(publication: Publication) {
    publication.canceled = true;
    if (publication.canceling) {
      publication.retryCancel = true;
      return;
    }
    publication.canceling = true;
    // Registration can race cancellation. The native registration progress event
    // gives us another chance; busy remains charged until publication settles.
    void Promise.resolve()
      .then(() =>
        publication.source.services.cancelClipboardPreparation!(
          publication.nativeId,
        ),
      )
      .catch(() => {})
      .finally(() => {
        publication.canceling = false;
        if (publication.retryCancel && this.publishing === publication) {
          publication.retryCancel = false;
          this.cancel(publication);
        }
      });
  }
  close() {
    this.closed = true;
    this.staged = undefined;
    if (this.publishing) this.cancel(this.publishing);
  }
  refresh() {
    if (
      this.staged &&
      (!this.same(this.staged) || !this.supported(this.staged.kind))
    )
      this.staged = undefined;
    if (
      this.publishing &&
      (!this.same(this.publishing) || !this.supported(this.publishing.kind))
    )
      this.cancel(this.publishing);
  }
  private async publish(
    selection: Selection,
    signal: AbortSignal,
  ): Promise<null> {
    const publication: Publication = {
      ...selection,
      nativeId: crypto.randomUUID(),
      canceled: false,
      canceling: false,
      retryCancel: false,
    };
    this.publishing = publication;
    this.busyChanged(true);
    const abort = () => this.cancel(publication);
    signal.addEventListener("abort", abort, { once: true });
    try {
      const preparation = {
        id: publication.nativeId,
        onProgress: () => {
          if (publication.canceled) this.cancel(publication);
        },
      };
      if (publication.kind === "cut") {
        const entry = publication.entries[0];
        await publication.source.services.cutToSystem!(
          entry.path,
          entry.revision,
          preparation,
          false,
        );
      } else {
        await publication.source.services.copyToSystem!(
          publication.entries,
          preparation,
        );
      }
      if (publication.canceled || !this.same(publication))
        throw new RpcError(
          "aborted",
          "Clipboard publication ended after cancellation or a connection change. It may have completed; do not retry automatically.",
        );
      return null;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError(
        "failed",
        String(error instanceof Error ? error.message : error).slice(0, 4096),
      );
    } finally {
      signal.removeEventListener("abort", abort);
      this.publishing = undefined;
      this.busyChanged(false);
    }
  }
  methods(): ReadonlyMap<string, RpcMethod> {
    const method = (
      invoke: RpcMethod["invoke"],
      kind: Selection["kind"] = "copy",
    ): RpcMethod => ({
      grants: [
        "system.clipboard.files.write",
        kind === "cut" ? "files.move" : "files.download",
      ],
      available: () => this.supported(kind),
      invoke: (value, signal) => {
        if (this.closed)
          throw new RpcError("closed", "Clipboard owner closed.");
        if (signal.aborted)
          throw new RpcError("aborted", "Clipboard operation canceled.");
        if (!this.supported(kind))
          throw new RpcError(
            "unavailable",
            "Native file clipboard export is unavailable.",
          );
        return invoke(value, signal);
      },
    });
    return new Map([
      [
        "system.clipboard.files.cut",
        method(async (value, signal) => {
          const p = args(value, ["id", "binding", "path", "revision"]);
          const source = this.source()!;
          if (p.binding !== source.binding)
            throw new RpcError(
              "closed",
              "Cut an entry from the accepted workspace binding.",
            );
          if (
            typeof p.path !== "string" ||
            !p.path ||
            typeof p.revision !== "string" ||
            !p.revision
          )
            throw new RpcError(
              "invalid",
              "A cut entry needs an opaque path and current revision.",
            );
          if (this.staged || this.publishing)
            throw new RpcError(
              "busy",
              "Finish or cancel the previous clipboard publication first.",
            );
          return this.publish(
            {
              kind: "cut",
              id: p.id,
              source,
              entries: [{ path: p.path, revision: p.revision }],
            },
            signal,
          );
        }, "cut"),
      ],
      [
        "system.clipboard.files.start",
        method((value) => {
          const p = args(value, ["id", "binding"]);
          const source = this.source()!;
          if (p.binding !== source.binding)
            throw new RpcError(
              "closed",
              "Copy entries from the accepted workspace binding.",
            );
          if (this.staged || this.publishing)
            throw new RpcError(
              "busy",
              "Finish or cancel the previous file copy first.",
            );
          this.staged = { kind: "copy", id: p.id, source, entries: [] };
          return null;
        }),
      ],
      [
        "system.clipboard.files.append",
        method((value) => {
          const p = args(value, ["id", "offset", "entries"]),
            staged = this.staged;
          if (!staged || staged.id !== p.id || !this.same(staged))
            throw new RpcError(
              "closed",
              "Clipboard selection is closed or belongs to another window.",
            );
          if (
            p.offset !== staged.entries.length ||
            !Array.isArray(p.entries) ||
            !p.entries.length ||
            p.entries.length > 128
          )
            throw new RpcError(
              "invalid",
              "Send clipboard root references in order, at most 128 per chunk.",
            );
          const entries = p.entries.map((entry) => {
            if (
              !entry ||
              typeof entry !== "object" ||
              Array.isArray(entry) ||
              Object.keys(entry).length !== 2 ||
              typeof entry.path !== "string" ||
              !entry.path ||
              typeof entry.revision !== "string" ||
              !entry.revision
            )
              throw new RpcError(
                "invalid",
                "Each copied entry needs an opaque path and current revision.",
              );
            return { path: entry.path, revision: entry.revision };
          });
          staged.entries.push(...entries);
          return null;
        }),
      ],
      [
        "system.clipboard.files.commit",
        method(async (value, signal) => {
          const p = args(value, ["id"]),
            staged = this.staged;
          if (!staged || staged.id !== p.id || !this.same(staged))
            throw new RpcError(
              "closed",
              "Clipboard selection is no longer owned by this window.",
            );
          if (!staged.entries.length)
            throw new RpcError("invalid", "Select files or folders first.");
          this.staged = undefined;
          return this.publish(staged, signal);
        }),
      ],
      [
        "system.clipboard.files.release",
        {
          grants: [],
          invoke: (value) => {
            const p = args(value, ["id"]);
            if (this.staged?.id === p.id) this.staged = undefined;
            if (this.publishing?.id === p.id) this.cancel(this.publishing);
            return null;
          },
        },
      ],
    ]);
  }
}
