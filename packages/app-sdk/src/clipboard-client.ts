// SPDX-License-Identifier: MPL-2.0
import { RpcError, type RpcPeer } from "./rpc.js";
import { appTransferClient, type RemoteTransfer } from "./transfer-client.js";
import type { RemoteFileLocation, RemoteEntryLocation } from "./file-client.js";
import {
  appImageClipboardClient,
  type ClipboardImage,
} from "./clipboard-image.js";
export interface AppClipboardAPI {
  /** Publish remote files/folders to the system clipboard for deferred native paste. */
  copyFiles(
    entries: RemoteEntryLocation[],
    signal?: AbortSignal,
  ): Promise<void>;
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
    async copyFiles(entries, signal) {
      const snapshot = entries.map(({ binding, path, revision }) => ({
        binding,
        path,
        revision,
      }));
      if (
        !snapshot.length ||
        snapshot.some(
          (entry) =>
            entry.binding !== snapshot[0].binding ||
            !entry.path ||
            !entry.revision,
        )
      )
        throw new RpcError(
          "invalid",
          "Copy current file entries from one workspace binding.",
        );
      const id = crypto.randomUUID();
      try {
        await peer.call(
          "system.clipboard.files.start",
          { id, binding: snapshot[0].binding },
          signal,
        );
        for (let offset = 0; offset < snapshot.length;) {
          const chunk: { path: string; revision: string }[] = [];
          let size = 0;
          while (
            offset + chunk.length < snapshot.length &&
            chunk.length < 128
          ) {
            const { path, revision } = snapshot[offset + chunk.length];
            const entry = { path, revision };
            const length = JSON.stringify(entry).length;
            if (chunk.length && size + length > 64 * 1024) break;
            chunk.push(entry);
            size += length;
          }
          await peer.call(
            "system.clipboard.files.append",
            {
              id,
              offset,
              entries: chunk,
            },
            signal,
          );
          offset += chunk.length;
        }
        await peer.call("system.clipboard.files.commit", { id }, signal);
      } finally {
        await peer
          .call("system.clipboard.files.release", { id })
          .catch(() => {});
      }
    },
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
