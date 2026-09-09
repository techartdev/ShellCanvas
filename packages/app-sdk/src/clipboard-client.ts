// SPDX-License-Identifier: MPL-2.0
import { RpcError, type RpcPeer } from "./rpc.js";
import { appTransferClient, type RemoteTransfer } from "./transfer-client.js";
import type { RemoteFileLocation } from "./file-client.js";
import {
  appImageClipboardClient,
  type ClipboardImage,
} from "./clipboard-image.js";
export interface AppClipboardAPI {
  /** Prepare clipboard files/folders for upload. Run and close the returned owned transfer handles. */
  pasteFiles(
    destination: RemoteFileLocation,
    signal?: AbortSignal,
  ): Promise<RemoteTransfer[]>;
  readText(signal?: AbortSignal): Promise<string>;
  writeText(text: string, signal?: AbortSignal): Promise<void>;
  readImage(signal?: AbortSignal): Promise<ClipboardImage>;
  writeImage(image: ClipboardImage, signal?: AbortSignal): Promise<void>;
}
const chunkSize = 64 * 1024;
export function appClipboardClient(
  peer: Pick<RpcPeer, "call">,
): AppClipboardAPI {
  const release = (id: string) =>
    peer.call("system.clipboard.release", { id }).catch(() => {});
  return Object.freeze({
    pasteFiles: appTransferClient(peer).pasteClipboard,
    ...appImageClipboardClient(peer),
    async readText(signal) {
      const id = crypto.randomUUID();
      const chunks: string[] = [];
      try {
        const start = (await peer.call(
          "system.clipboard.readStart",
          { id },
          signal,
        )) as { id: string; length: number };
        let offset = 0;
        while (offset < start.length) {
          const chunk = await peer.call(
            "system.clipboard.readChunk",
            { id: start.id, offset },
            signal,
          );
          if (
            typeof chunk !== "string" ||
            !chunk.length ||
            offset + chunk.length > start.length
          )
            throw new RpcError("failed", "Invalid clipboard text stream.");
          chunks.push(chunk);
          offset += chunk.length;
        }
        return chunks.join("");
      } finally {
        await release(id);
      }
    },
    async writeText(text, signal) {
      if (typeof text !== "string")
        throw new RpcError("invalid", "Clipboard text must be a string.");
      const id = crypto.randomUUID();
      try {
        await peer.call(
          "system.clipboard.writeStart",
          { id, length: text.length },
          signal,
        );
        for (let offset = 0; offset < text.length; offset += chunkSize)
          await peer.call(
            "system.clipboard.writeChunk",
            { id, offset, text: text.slice(offset, offset + chunkSize) },
            signal,
          );
        await peer.call("system.clipboard.writeCommit", { id }, signal);
      } finally {
        await release(id);
      }
    },
  } satisfies AppClipboardAPI);
}
