// SPDX-License-Identifier: MPL-2.0
import type { ClipboardService } from "../clipboard";
import { RpcError, type Json, type RpcMethod } from "./rpc";
import { AppImageClipboard } from "./image-clipboard-api";
export type { AppClipboardAPI } from "../../packages/app-sdk/src/clipboard-client";
const chunkSize = 64 * 1024;
function identity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(value))
    throw new RpcError("invalid", "Invalid clipboard operation identity.");
}
function options(value: Json, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new RpcError("invalid", "Invalid clipboard request.");
  return value;
}
/** One captured read and one staged write per window; no native clipboard lock is retained. */
export class AppClipboard {
  private closed = false;
  private committing = false;
  private reader?: { id: string; text: string | null; offset: number };
  private writer?: {
    id: string;
    length: number;
    offset: number;
    chunks: string[];
  };
  private images: AppImageClipboard;
  constructor(private backend: ClipboardService) {
    this.images = new AppImageClipboard(backend);
  }
  close() {
    this.images.close();
    this.closed = true;
    this.reader = undefined;
    this.writer = undefined;
  }
  methods(): ReadonlyMap<string, RpcMethod> {
    const method = (
      grant: string | null,
      action: (params: Json, signal: AbortSignal) => Promise<Json> | Json,
    ): RpcMethod => ({
      grants: grant ? [grant] : [],
      invoke: (params, signal) => {
        if (this.closed)
          throw new RpcError("closed", "The clipboard owner has closed.");
        if (signal.aborted)
          throw new RpcError("aborted", "Clipboard operation canceled.");
        return action(params, signal);
      },
    });
    const read = "system.clipboard.read",
      write = "system.clipboard.write";
    return new Map([
      ...this.images.methods(),
      [
        "system.clipboard.readStart",
        method(read, async (params, signal) => {
          const args = options(params, ["id"]);
          identity(args.id);
          if (this.writer?.id === args.id)
            throw new RpcError(
              "invalid",
              "Clipboard identity is already in use.",
            );
          if (this.reader)
            throw new RpcError(
              "busy",
              "A clipboard read is already active in this window.",
            );
          const reader = {
            id: args.id,
            text: null as string | null,
            offset: 0,
          };
          this.reader = reader;
          try {
            const text = await this.backend.readText();
            if (this.closed || signal.aborted || this.reader !== reader)
              throw new RpcError("aborted", "Clipboard read canceled.");
            if (typeof text !== "string")
              throw new Error("Invalid clipboard text");
            reader.text = text;
            return { id: reader.id, length: text.length };
          } catch (error) {
            if (this.reader === reader) this.reader = undefined;
            if (error instanceof RpcError) throw error;
            throw new RpcError("failed", "Unable to read clipboard text.");
          }
        }),
      ],
      [
        "system.clipboard.readChunk",
        method(read, (params) => {
          const args = options(params, ["id", "offset"]),
            reader = this.reader;
          if (!reader || reader.id !== args.id || reader.text === null)
            throw new RpcError(
              "denied",
              "This clipboard read does not belong to the window.",
            );
          if (args.offset !== reader.offset)
            throw new RpcError(
              "invalid",
              "Clipboard chunks must be read in order.",
            );
          const text = reader.text.slice(
            reader.offset,
            reader.offset + chunkSize,
          );
          reader.offset += text.length;
          if (reader.offset === reader.text.length) this.reader = undefined;
          return text;
        }),
      ],
      [
        "system.clipboard.writeStart",
        method(write, (params) => {
          const args = options(params, ["id", "length"]);
          identity(args.id);
          if (this.reader?.id === args.id)
            throw new RpcError(
              "invalid",
              "Clipboard identity is already in use.",
            );
          if (
            typeof args.length !== "number" ||
            !Number.isSafeInteger(args.length) ||
            args.length < 0
          )
            throw new RpcError("invalid", "Invalid clipboard text length.");
          if (this.writer || this.committing)
            throw new RpcError(
              "busy",
              "A clipboard write is already active in this window.",
            );
          this.writer = {
            id: args.id,
            length: args.length,
            offset: 0,
            chunks: [],
          };
          return this.writer.id;
        }),
      ],
      [
        "system.clipboard.writeChunk",
        method(write, (params) => {
          const args = options(params, ["id", "offset", "text"]),
            writer = this.writer;
          if (!writer || writer.id !== args.id)
            throw new RpcError(
              "denied",
              "This clipboard write does not belong to the window.",
            );
          if (
            args.offset !== writer.offset ||
            typeof args.text !== "string" ||
            !args.text.length ||
            args.text.length > chunkSize ||
            writer.offset + args.text.length > writer.length
          )
            throw new RpcError(
              "invalid",
              "Invalid or out-of-order clipboard chunk.",
            );
          writer.chunks.push(args.text);
          writer.offset += args.text.length;
          return null;
        }),
      ],
      [
        "system.clipboard.writeCommit",
        method(write, async (params) => {
          const args = options(params, ["id"]),
            writer = this.writer;
          if (!writer || writer.id !== args.id)
            throw new RpcError(
              "denied",
              "This clipboard write does not belong to the window.",
            );
          if (writer.offset !== writer.length)
            throw new RpcError("invalid", "Clipboard text is incomplete.");
          this.writer = undefined;
          this.committing = true;
          try {
            await this.backend.writeText(writer.chunks.join(""));
            return null;
          } catch {
            throw new RpcError("failed", "Unable to replace clipboard text.");
          } finally {
            this.committing = false;
          }
        }),
      ],
      [
        "system.clipboard.release",
        method(null, (params) => {
          const args = options(params, ["id"]);
          if (typeof args.id !== "string")
            throw new RpcError(
              "invalid",
              "A clipboard operation identity is required.",
            );
          if (this.reader?.id === args.id) this.reader = undefined;
          if (this.writer?.id === args.id) this.writer = undefined;
          return null;
        }),
      ],
    ]);
  }
}
export { appClipboardClient } from "../../packages/app-sdk/src/clipboard-client";
