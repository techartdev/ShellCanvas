// SPDX-License-Identifier: MPL-2.0
import { invoke, isTauri } from "@tauri-apps/api/core";
import { RpcError, type Json, type RpcMethod } from "./rpc";
import type { AppConnection } from "../../packages/app-sdk/src/network-client";
export interface ConnectionPrompt {
  app: string;
  title: string;
  slot: string;
  suggestedEndpoint: string;
  signal: AbortSignal;
}
export type ConfigureConnection = (
  request: ConnectionPrompt,
) => Promise<AppConnection | null>;
export interface NetworkBackend {
  available(): boolean;
  profile(app: string, slot: string): Promise<AppConnection | null>;
  forget(app: string, slot: string): Promise<void>;
  prepare(owner: string): Promise<string>;
  start(
    owner: string,
    id: string,
    app: string,
    slot: string,
    revision: string,
    body: string,
  ): Promise<{ status: number; contentType: string }>;
  read(owner: string, id: string): Promise<number[] | null>;
  close(owner: string, id: string): Promise<void>;
}
export const nativeNetwork: NetworkBackend = {
  available: isTauri,
  profile: (app, slot) => invoke("app_network_profile", { app, slot }),
  forget: (app, slot) => invoke("app_network_forget", { app, slot }),
  prepare: (owner) => invoke("app_network_prepare", { owner }),
  start: (owner, id, app, slot, revision, body) =>
    invoke("app_network_start", { owner, id, app, slot, revision, body }),
  read: (owner, id) => invoke("app_network_read", { owner, id }),
  close: (owner, id) => invoke("app_network_close", { owner, id }),
};
function options(params: Json, fields: readonly string[]) {
  if (
    !params ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    Object.keys(params).some((key) => !fields.includes(key))
  )
    throw new RpcError("invalid", "Invalid network options.");
  return params;
}
function text(value: unknown, limit: number): asserts value is string {
  if (typeof value !== "string" || value.length > limit)
    throw new RpcError("invalid", "Invalid network value.");
}
function slot(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value))
    throw new RpcError("invalid", "Invalid connection slot.");
}
interface OpenRequest {
  controller: AbortController;
  native?: string;
  reading: boolean;
  bytes: number[];
  offset: number;
}
export class AppNetwork {
  private owner = crypto.randomUUID();
  private requests = new Map<string, OpenRequest>();
  private retired = false;
  constructor(
    private app: string,
    private title: string,
    private configure: ConfigureConnection,
    private backend = nativeNetwork,
  ) {}
  private async release(id: string) {
    const current = this.requests.get(id);
    if (!current) return;
    this.requests.delete(id);
    current.controller.abort();
    if (current.native) await this.backend.close(this.owner, current.native);
  }
  close() {
    this.retired = true;
    for (const id of this.requests.keys())
      void this.release(id).catch(() => {});
  }
  methods(): ReadonlyMap<string, RpcMethod> {
    const methods = new Map<string, RpcMethod>();
    const add = (name: string, handler: RpcMethod["invoke"], cleanup = false) =>
      methods.set(`system.network.${name}`, {
        grants: cleanup ? [] : ["system.network"],
        available: () => this.backend.available() && !this.retired,
        invoke: (params, signal) => {
          if (this.retired) throw new RpcError("closed", "App network closed.");
          return handler(params, signal);
        },
      });
    add("profile", async (params) => {
      const args = options(params, ["slot"]);
      slot(args.slot);
      return (await this.backend.profile(
        this.app,
        args.slot,
      )) as unknown as Json;
    });
    add("configure", async (params, signal) => {
      const args = options(params, ["slot", "suggestedEndpoint"]);
      slot(args.slot);
      text(args.suggestedEndpoint, 2048);
      return (await this.configure({
        app: this.app,
        title: this.title,
        slot: args.slot,
        suggestedEndpoint: args.suggestedEndpoint,
        signal,
      })) as unknown as Json;
    });
    add("forget", async (params) => {
      const args = options(params, ["slot"]);
      slot(args.slot);
      await this.backend.forget(this.app, args.slot);
      return null;
    });
    add("start", async (params, signal) => {
      const args = options(params, ["id", "slot", "revision", "body"]);
      text(args.id, 100);
      slot(args.slot);
      text(args.revision, 100);
      if (!args.id || this.requests.has(args.id))
        throw new RpcError("invalid", "Duplicate HTTP request.");
      if (this.requests.size >= 4)
        throw new RpcError("busy", "Close an existing HTTP request first.");
      const body = JSON.stringify(args.body);
      if (!body || new TextEncoder().encode(body).length > 3 * 1024 * 1024)
        throw new RpcError("invalid", "JSON request exceeds 3 MiB.");
      const id = args.id;
      const record: OpenRequest = {
        controller: new AbortController(),
        reading: false,
        bytes: [],
        offset: 0,
      };
      this.requests.set(id, record);
      const abort = () => {
        void this.release(id).catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        record.native = await this.backend.prepare(this.owner);
        if (record.controller.signal.aborted || this.retired) {
          await this.backend.close(this.owner, record.native);
          throw new RpcError("aborted", "HTTP request canceled.");
        }
        const result = await this.backend.start(
          this.owner,
          record.native,
          this.app,
          args.slot,
          args.revision,
          body,
        );
        signal.throwIfAborted();
        record.controller.signal.throwIfAborted();
        return result;
      } catch (error) {
        await this.release(id);
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    });
    add("read", async (params, signal) => {
      const args = options(params, ["id"]);
      text(args.id, 100);
      const record = this.requests.get(args.id);
      if (!record?.native)
        throw new RpcError("closed", "HTTP response closed.");
      if (record.reading)
        throw new RpcError("busy", "Wait for the current response read.");
      const id = args.id;
      record.reading = true;
      const abort = () => {
        void this.release(id).catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        signal.throwIfAborted();
        if (record.offset >= record.bytes.length) {
          const bytes = await this.backend.read(this.owner, record.native);
          signal.throwIfAborted();
          record.controller.signal.throwIfAborted();
          if (bytes === null) {
            await this.release(id);
            return null;
          }
          record.bytes = bytes;
          record.offset = 0;
        }
        const result = record.bytes.slice(record.offset, record.offset + 32768);
        record.offset += result.length;
        return result;
      } catch (error) {
        await this.release(id);
        throw error;
      } finally {
        record.reading = false;
        signal.removeEventListener("abort", abort);
      }
    });
    add(
      "close",
      async (params) => {
        const args = options(params, ["id"]);
        text(args.id, 100);
        await this.release(args.id);
        return null;
      },
      true,
    );
    return methods;
  }
}
