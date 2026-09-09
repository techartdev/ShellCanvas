// SPDX-License-Identifier: MPL-2.0
import { RpcError, type Json, type RpcPeer } from "./rpc.js";
import type { RemoteEntryLocation, RemoteFileLocation } from "./file-client.js";

export interface TransferProgress {
  bytes: number;
  total: number;
  items?: number;
  phase: "preparing" | "running" | "finishing";
}
export interface TransferResult {
  status: "completed" | "canceled" | "failed";
  bytes: number;
  total: number;
  message?: string | null;
  /** Remote destination only. Local download paths are not exposed. */
  destination?: RemoteFileLocation;
}
export interface TransferSnapshot {
  revision: number;
  state:
    | "queued"
    | "running"
    | "canceling"
    | "cancel-failed"
    | "completed"
    | "canceled"
    | "failed";
  progress: TransferProgress;
  result?: TransferResult;
  cancellationError?: string;
}
export interface RemoteTransfer {
  readonly binding: string;
  readonly name: string;
  readonly size: number;
  readonly direction: "upload" | "download" | "copy" | "move";
  /** Starts once. Cancellation requests cleanup and waits for the actual outcome. */
  run(signal?: AbortSignal): Promise<TransferResult>;
  status(): Promise<TransferSnapshot>;
  /** Coalesced progress snapshots, not a durable event log. Breaking stops watching only. */
  watch(signal?: AbortSignal): AsyncIterable<TransferSnapshot>;
  cancel(): Promise<void>;
  /** Cancel unfinished work and release the handle after its outcome is known. */
  close(): Promise<void>;
}
export interface AppTransfersAPI {
  /** Prepare the file clipboard as owned upload/copy/move work. Does not start it. */
  pasteClipboard(
    destination: RemoteFileLocation,
    signal?: AbortSignal,
  ): Promise<RemoteTransfer[]>;
  upload(
    destination: RemoteFileLocation,
    options?: { folder?: boolean },
    signal?: AbortSignal,
  ): Promise<RemoteTransfer[]>;
  download(
    entry: RemoteEntryLocation,
    signal?: AbortSignal,
  ): Promise<RemoteTransfer | null>;
  downloadMany(
    entries: readonly RemoteEntryLocation[],
    signal?: AbortSignal,
  ): Promise<RemoteTransfer[]>;
  copy(
    entry: RemoteEntryLocation,
    destination: RemoteFileLocation,
    signal?: AbortSignal,
  ): Promise<RemoteTransfer>;
}
interface Prepared {
  id: string;
  binding: string;
  name: string;
  size: number;
  direction: RemoteTransfer["direction"];
}
export function appTransferClient(
  peer: Pick<RpcPeer, "call">,
): AppTransfersAPI {
  const handle = (item: Prepared): RemoteTransfer => {
    let closed = false;
    let running: Promise<TransferResult> | undefined;
    let closing: Promise<void> | undefined;
    const call = (
      method: string,
      extra: Record<string, Json> = {},
      signal?: AbortSignal,
    ) => {
      if (closed)
        return Promise.reject(
          new RpcError("closed", "Transfer handle is closed."),
        );
      return peer.call(
        `system.transfers.${method}`,
        { id: item.id, ...extra },
        signal,
      );
    };
    const cancel = async () => {
      await call("cancel");
    };
    return {
      binding: item.binding,
      name: item.name,
      size: item.size,
      direction: item.direction,
      async run(signal) {
        const abort = () => {
          void cancel().catch(() => {});
        };
        signal?.addEventListener("abort", abort, { once: true });
        try {
          if (signal?.aborted) await cancel();
          running ??= call("run") as unknown as Promise<TransferResult>;
          return await running;
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      },
      async status() {
        return (await call("status", {
          after: null,
        })) as unknown as TransferSnapshot;
      },
      async *watch(signal) {
        let after: number | null = null;
        for (;;) {
          const snapshot = (await call(
            "status",
            { after },
            signal,
          )) as unknown as TransferSnapshot;
          yield snapshot;
          if (snapshot.result) return;
          after = snapshot.revision;
        }
      },
      cancel,
      close() {
        if (closing) return closing;
        closing = call("close").then(
          () => {
            closed = true;
          },
          (error) => {
            closing = undefined;
            throw error;
          },
        );
        return closing;
      },
    };
  };
  async function prepare(
    method: string,
    options: Record<string, Json>,
    signal?: AbortSignal,
  ) {
    const id = crypto.randomUUID();
    try {
      const items = (await peer.call(
        `system.transfers.${method}`,
        { id, ...options },
        signal,
      )) as unknown as Prepared[];
      if (signal?.aborted)
        throw new RpcError("aborted", "Transfer preparation canceled.");
      return items.map(handle);
    } catch (error) {
      // A chooser may finish after cancellation; the operation identity owns
      // every late ticket even when the app never received a response.
      void peer
        .call("system.transfers.cancelPreparation", { id })
        .catch(() => {});
      throw error;
    }
  }
  return {
    pasteClipboard: async (destination, signal) => {
      const snapshot = (await peer.call(
        "system.transfers.clipboardInspect",
        { binding: destination.binding },
        signal,
      )) as {
        kind: "remote" | "local" | "empty";
        sequence: number | null;
        intent?: "copy" | "move";
      };
      if (snapshot.kind === "empty") return [];
      return prepare(
        snapshot.sequence === null
          ? "clipboardPaste"
          : snapshot.kind === "remote"
            ? snapshot.intent === "move"
              ? "clipboardMoveSnapshot"
              : "clipboardCopySnapshot"
            : "clipboardPasteSnapshot",
        {
          binding: destination.binding,
          parent: destination.path,
          ...(snapshot.sequence === null
            ? {}
            : { sequence: snapshot.sequence }),
        },
        signal,
      );
    },
    upload: (destination, options, signal) =>
      prepare(
        options?.folder ? "uploadFolder" : "upload",
        { binding: destination.binding, parent: destination.path },
        signal,
      ),
    async download(entry, signal) {
      return (
        (
          await prepare(
            "download",
            {
              binding: entry.binding,
              path: entry.path,
              revision: entry.revision,
            },
            signal,
          )
        )[0] ?? null
      );
    },
    downloadMany: (entries, signal) =>
      prepare(
        "downloadMany",
        {
          binding: entries[0]?.binding ?? "",
          entries: entries.map((entry) => ({
            binding: entry.binding,
            path: entry.path,
            revision: entry.revision,
          })),
        },
        signal,
      ),
    async copy(entry, destination, signal) {
      return (
        await prepare(
          "copy",
          {
            binding: entry.binding,
            path: entry.path,
            revision: entry.revision,
            parent: destination.path,
            parentBinding: destination.binding,
          },
          signal,
        )
      )[0];
    },
  };
}
