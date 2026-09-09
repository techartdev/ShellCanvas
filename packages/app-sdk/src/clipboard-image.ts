// SPDX-License-Identifier: MPL-2.0
import { RpcError, type RpcPeer } from "./rpc.js";
/** RGBA bytes, row-major from top to bottom. Each pixel uses four bytes. */
export interface ClipboardImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}
export const imageChunkSize = 32 * 1024;
export function imageByteLength(width: unknown, height: unknown): number {
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 0xffffffff ||
    height > 0xffffffff ||
    !Number.isSafeInteger(width * height * 4)
  )
    throw new RpcError(
      "invalid",
      "Provide positive image dimensions with a representable RGBA length.",
    );
  return width * height * 4;
}
export function imageBytes(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= imageChunkSize &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  );
}
export function appImageClipboardClient(peer: Pick<RpcPeer, "call">) {
  const release = (id: string) =>
    peer.call("system.clipboard.image.release", { id }).catch(() => {});
  return {
    async readImage(signal?: AbortSignal): Promise<ClipboardImage> {
      const id = crypto.randomUUID();
      try {
        const meta = (await peer.call(
          "system.clipboard.image.readStart",
          { id },
          signal,
        )) as { width: number; height: number };
        const length = imageByteLength(meta?.width, meta?.height);
        const rgba = new Uint8Array(length);
        let offset = 0;
        while (offset < length) {
          const bytes = await peer.call(
            "system.clipboard.image.readChunk",
            { id, offset },
            signal,
          );
          if (!imageBytes(bytes) || offset + bytes.length > length)
            throw new RpcError("failed", "Invalid clipboard image stream.");
          rgba.set(bytes, offset);
          offset += bytes.length;
        }
        return { width: meta.width, height: meta.height, rgba };
      } finally {
        await release(id);
      }
    },
    async writeImage(
      image: ClipboardImage,
      signal?: AbortSignal,
    ): Promise<void> {
      const length = imageByteLength(image?.width, image?.height);
      if (!(image.rgba instanceof Uint8Array) || image.rgba.length !== length)
        throw new RpcError(
          "invalid",
          "Image dimensions must match the RGBA bytes.",
        );
      // Capture before the first await, so edits by the caller cannot change later chunks.
      const rgba = image.rgba.slice(),
        width = image.width,
        height = image.height;
      const id = crypto.randomUUID();
      try {
        await peer.call(
          "system.clipboard.image.writeStart",
          { id, width, height },
          signal,
        );
        for (let offset = 0; offset < length; offset += imageChunkSize)
          await peer.call(
            "system.clipboard.image.writeChunk",
            {
              id,
              offset,
              bytes: Array.from(rgba.subarray(offset, offset + imageChunkSize)),
            },
            signal,
          );
        await peer.call("system.clipboard.image.writeCommit", { id }, signal);
      } finally {
        await release(id);
      }
    },
  };
}
