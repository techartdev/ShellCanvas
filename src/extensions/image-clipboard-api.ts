// SPDX-License-Identifier: MPL-2.0
import type { ClipboardService } from "../clipboard";
import { RpcError, type Json, type RpcMethod } from "./rpc";
import {
  imageByteLength,
  imageBytes,
  imageChunkSize,
  type ClipboardImage,
} from "../../packages/app-sdk/src/clipboard-image";

function options(value: Json, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(value.id)
  )
    throw new RpcError("invalid", "Invalid clipboard image request.");
  return value as Record<string, Json> & { id: string };
}
/** Independent image stream ownership; OS publication is a single complete-image operation. */
export class AppImageClipboard {
  private closed = false;
  private committing = false;
  private reading = false;
  private reader?: { id: string; image?: ClipboardImage; offset: number };
  private writer?: {
    id: string;
    width: number;
    height: number;
    length: number;
    offset: number;
    chunks: Uint8Array[];
  };
  constructor(private backend: ClipboardService) {}
  close() {
    this.closed = true;
    this.reader = undefined;
    this.writer = undefined;
  }
  methods(): ReadonlyMap<string, RpcMethod> {
    const method = (
      kind: "read" | "write" | null,
      action: RpcMethod["invoke"],
    ): RpcMethod => ({
      grants: kind ? [`system.clipboard.image.${kind}`] : [],
      available: () =>
        !this.closed &&
        (!kind ||
          typeof this.backend[kind === "read" ? "readImage" : "writeImage"] ===
            "function"),
      invoke: (params, signal) => {
        if (this.closed)
          throw new RpcError("closed", "The clipboard image owner has closed.");
        if (signal.aborted)
          throw new RpcError("aborted", "Clipboard image operation canceled.");
        return action(params, signal);
      },
    });
    return new Map([
      [
        "system.clipboard.image.readStart",
        method("read", async (params, signal) => {
          const { id } = options(params, ["id"]);
          if (this.reader || this.reading)
            throw new RpcError(
              "busy",
              "A clipboard image read is already active.",
            );
          if (this.writer?.id === id)
            throw new RpcError(
              "invalid",
              "Clipboard image identity is already in use.",
            );
          const reader = {
            id,
            offset: 0,
            image: undefined as ClipboardImage | undefined,
          };
          this.reader = reader;
          this.reading = true;
          try {
            const image = await this.backend.readImage!();
            if (this.closed || signal.aborted || this.reader !== reader)
              throw new RpcError("aborted", "Clipboard image read canceled.");
            const length = imageByteLength(image?.width, image?.height);
            if (
              !(image.rgba instanceof Uint8Array) ||
              image.rgba.length !== length
            )
              throw new RpcError("failed", "Invalid clipboard image data.");
            reader.image = {
              width: image.width,
              height: image.height,
              rgba: image.rgba.slice(),
            };
            return { width: image.width, height: image.height };
          } catch (error) {
            if (this.reader === reader) this.reader = undefined;
            if (error instanceof RpcError) throw error;
            throw new RpcError("failed", "Unable to read a clipboard image.");
          } finally {
            this.reading = false;
          }
        }),
      ],
      [
        "system.clipboard.image.readChunk",
        method("read", (params) => {
          const args = options(params, ["id", "offset"]),
            reader = this.reader;
          if (!reader?.image || reader.id !== args.id)
            throw new RpcError(
              "denied",
              "This clipboard image read does not belong to the window.",
            );
          if (args.offset !== reader.offset)
            throw new RpcError("invalid", "Out-of-order clipboard image read.");
          const bytes = Array.from(
            reader.image.rgba.subarray(
              reader.offset,
              reader.offset + imageChunkSize,
            ),
          );
          reader.offset += bytes.length;
          if (reader.offset === reader.image.rgba.length)
            this.reader = undefined;
          return bytes;
        }),
      ],
      [
        "system.clipboard.image.writeStart",
        method("write", (params) => {
          const args = options(params, ["id", "width", "height"]);
          const length = imageByteLength(args.width, args.height);
          if (this.writer || this.committing)
            throw new RpcError(
              "busy",
              "A clipboard image write is already active.",
            );
          if (this.reader?.id === args.id)
            throw new RpcError(
              "invalid",
              "Clipboard image identity is already in use.",
            );
          this.writer = {
            id: args.id,
            width: args.width as number,
            height: args.height as number,
            length,
            offset: 0,
            chunks: [],
          };
          return null;
        }),
      ],
      [
        "system.clipboard.image.writeChunk",
        method("write", (params) => {
          const args = options(params, ["id", "offset", "bytes"]),
            writer = this.writer;
          if (!writer || writer.id !== args.id)
            throw new RpcError(
              "denied",
              "This clipboard image write does not belong to the window.",
            );
          if (
            args.offset !== writer.offset ||
            !imageBytes(args.bytes) ||
            writer.offset + args.bytes.length > writer.length
          )
            throw new RpcError(
              "invalid",
              "Invalid or out-of-order clipboard image chunk.",
            );
          writer.chunks.push(Uint8Array.from(args.bytes));
          writer.offset += args.bytes.length;
          return null;
        }),
      ],
      [
        "system.clipboard.image.writeCommit",
        method("write", async (params) => {
          const { id } = options(params, ["id"]),
            writer = this.writer;
          if (!writer || writer.id !== id)
            throw new RpcError(
              "denied",
              "This clipboard image write does not belong to the window.",
            );
          if (writer.offset !== writer.length)
            throw new RpcError("invalid", "Clipboard image is incomplete.");
          this.writer = undefined;
          this.committing = true;
          try {
            const rgba = new Uint8Array(writer.length);
            let offset = 0;
            for (const chunk of writer.chunks) {
              rgba.set(chunk, offset);
              offset += chunk.length;
            }
            writer.chunks.length = 0;
            await this.backend.writeImage!({
              width: writer.width,
              height: writer.height,
              rgba,
            });
            return null;
          } catch {
            throw new RpcError(
              "failed",
              "Clipboard image publication failed; check the clipboard before retrying.",
            );
          } finally {
            this.committing = false;
          }
        }),
      ],
      [
        "system.clipboard.image.release",
        method(null, (params) => {
          const { id } = options(params, ["id"]);
          if (this.reader?.id === id) this.reader = undefined;
          if (this.writer?.id === id) this.writer = undefined;
          return null;
        }),
      ],
    ]);
  }
}
