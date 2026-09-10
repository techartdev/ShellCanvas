// SPDX-License-Identifier: MPL-2.0
import { RpcError, type Json, type RpcPeer } from "./rpc.js";
export interface AppConnection {
  endpoint: string;
  revision: string;
  hasKey: boolean;
  remembered: boolean;
}
export interface AppHTTPResponse {
  status: number;
  contentType: string;
  read(signal?: AbortSignal): Promise<Uint8Array | null>;
  close(): Promise<void>;
}
export interface AppNetworkAPI {
  profile(slot: string, signal?: AbortSignal): Promise<AppConnection | null>;
  /** Opens a trusted desktop form. API keys are never returned to the app. */
  configure(
    options: { slot: string; suggestedEndpoint?: string },
    signal?: AbortSignal,
  ): Promise<AppConnection | null>;
  forget(slot: string, signal?: AbortSignal): Promise<void>;
  /** POST JSON only to this app's user-configured exact endpoint. No arbitrary headers or redirects. */
  postJSON(
    options: { slot: string; revision: string; body: Json },
    signal?: AbortSignal,
  ): Promise<AppHTTPResponse>;
}
export function appNetworkClient(peer: RpcPeer): AppNetworkAPI {
  return {
    profile: async (slot, signal) =>
      (await peer.call(
        "system.network.profile",
        { slot },
        signal,
      )) as unknown as AppConnection | null,
    configure: async (options, signal) =>
      (await peer.call(
        "system.network.configure",
        {
          slot: options.slot,
          suggestedEndpoint: options.suggestedEndpoint ?? "",
        },
        signal,
      )) as unknown as AppConnection | null,
    forget: async (slot, signal) => {
      await peer.call("system.network.forget", { slot }, signal);
    },
    async postJSON(options, signal) {
      const id = crypto.randomUUID();
      let closed = false,
        reading = false;
      let closing: Promise<void> | undefined;
      const close = () => {
        closed = true;
        signal?.removeEventListener("abort", abort);
        return (closing ??= peer
          .call("system.network.close", { id })
          .then(() => {}));
      };
      const abort = () => {
        void close().catch(() => {});
      };
      signal?.throwIfAborted();
      const starting = peer.call(
        "system.network.start",
        { id, ...options },
        signal,
      );
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const head = (await starting) as {
          status: number;
          contentType: string;
        };
        if (closed || signal?.aborted)
          throw new RpcError("aborted", "HTTP request canceled.");
        return {
          ...head,
          close,
          async read(control) {
            if (closed) throw new RpcError("closed", "HTTP response closed.");
            if (reading)
              throw new RpcError("busy", "Wait for the current response read.");
            reading = true;
            control?.addEventListener("abort", abort, { once: true });
            try {
              control?.throwIfAborted();
              const bytes = (await peer.call(
                "system.network.read",
                { id },
                control,
              )) as number[] | null;
              if (bytes === null) {
                await close();
                return null;
              }
              return Uint8Array.from(bytes);
            } catch (error) {
              abort();
              throw error;
            } finally {
              reading = false;
              control?.removeEventListener("abort", abort);
            }
          },
        };
      } catch (error) {
        abort();
        throw error;
      }
    },
  };
}
