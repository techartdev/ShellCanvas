// SPDX-License-Identifier: MPL-2.0
import { RpcError, type Json, type RpcPeer } from "./rpc.js";

export interface RemoteConsole {
  readonly binding: string;
  readonly resizable: boolean;
  /** One read at a time. null is EOF; bytes are never decoded implicitly. */
  read(signal?: AbortSignal): Promise<Uint8Array | null>;
  /** Strings use UTF-8. Await writes to preserve whole-write ordering. */
  write(bytes: Uint8Array | string, signal?: AbortSignal): Promise<void>;
  resize(cols: number, rows: number, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export interface AppConsoleAPI {
  /** Aborting this signal closes the console, including an opening still in flight. */
  open(
    options: { binding: string; cols?: number; rows?: number },
    signal?: AbortSignal,
  ): Promise<RemoteConsole>;
}
export function appConsoleClient(peer: RpcPeer): AppConsoleAPI {
  return {
    async open(options, signal) {
      const id = crypto.randomUUID();
      let closed = false;
      let closing: Promise<void> | undefined;
      let reading = false;
      let writing = false;
      let stopPeer = () => {};
      const close = () => {
        if (closing) return closing;
        closed = true;
        stopPeer();
        signal?.removeEventListener("abort", abort);
        closing = peer.call("system.console.close", { id }).then(() => {});
        return closing;
      };
      const abort = () => {
        void close().catch(() => {});
      };
      stopPeer = peer.onClose(() => {
        closed = true;
        signal?.removeEventListener("abort", abort);
        closing ??= Promise.resolve();
      });
      if (signal?.aborted) {
        stopPeer();
        throw new RpcError("aborted", "Console opening canceled.");
      }
      // A request and its cleanup share the client-chosen identity even if the
      // caller never receives the open response. Calls use an ordered channel.
      const opening = peer.call(
        "system.console.open",
        {
          id,
          binding: options.binding,
          cols: options.cols ?? 80,
          rows: options.rows ?? 24,
        },
        signal,
      );
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = (await opening) as {
          binding: string;
          resizable: boolean;
        };
        if (closed || signal?.aborted)
          throw new RpcError("aborted", "Console opening canceled.");
        const call = async (
          method: string,
          params: Json,
          control?: AbortSignal,
        ) => {
          if (closed) throw new RpcError("closed", "Console is closed.");
          const onAbort = () => {
            void close().catch(() => {});
          };
          control?.addEventListener("abort", onAbort, { once: true });
          try {
            if (control?.aborted) {
              onAbort();
              throw new RpcError(
                "aborted",
                "Console operation canceled; the console was closed.",
              );
            }
            return await peer.call(method, params, control);
          } finally {
            control?.removeEventListener("abort", onAbort);
          }
        };
        return {
          binding: result.binding,
          resizable: result.resizable,
          close,
          async read(control) {
            if (reading)
              throw new RpcError("busy", "Wait for the current console read.");
            reading = true;
            try {
              const value = (await call(
                "system.console.read",
                { id },
                control,
              )) as { bytes: number[] } | null;
              return value === null ? null : Uint8Array.from(value.bytes);
            } finally {
              reading = false;
            }
          },
          async write(data, control) {
            if (writing)
              throw new RpcError("busy", "Wait for the current console write.");
            const bytes =
              typeof data === "string"
                ? new TextEncoder().encode(data)
                : new Uint8Array(data);
            writing = true;
            try {
              // Include an empty write so a retired/denied console still refuses it.
              for (
                let offset = 0;
                offset < bytes.length || offset === 0;
                offset += 65536
              )
                await call(
                  "system.console.write",
                  {
                    id,
                    bytes: Array.from(bytes.subarray(offset, offset + 65536)),
                  },
                  control,
                );
            } finally {
              writing = false;
            }
          },
          async resize(cols, rows, control) {
            if (!result.resizable)
              throw new RpcError(
                "unavailable",
                "This console has fixed dimensions.",
              );
            await call("system.console.resize", { id, cols, rows }, control);
          },
        };
      } catch (error) {
        void close().catch(() => {});
        throw error;
      }
    },
  };
}
