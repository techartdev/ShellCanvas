// SPDX-License-Identifier: MPL-2.0
import type { FileEntry, TextDocument } from "./files.js";
import type { RpcPeer } from "./rpc.js";

/** Capture environment.binding before choosing or retaining a provider location. */
export interface RemoteFileLocation {
  binding: string;
  path: string;
}
/** Revision from a directory entry; it is not a text-document revision. */
export interface RemoteEntryLocation extends RemoteFileLocation {
  revision: string;
}
/** Keep this snapshot with the draft. Never substitute a new binding or revision. */
export interface RemoteTextDocument extends TextDocument {
  binding: string;
}
export interface RemoteDirectoryPage {
  binding: string;
  path: string;
  name: string;
  parent: string | null;
  home: { path: string; name: string } | null;
  roots: { path: string; name: string }[];
  entries: FileEntry[];
}
export interface AppFilesAPI {
  makeDirectory(
    destination: { binding: string; parent: string; name: string },
    signal?: AbortSignal,
  ): Promise<RemoteFileLocation>;
  renameEntry(
    entry: RemoteEntryLocation,
    name: string,
    signal?: AbortSignal,
  ): Promise<RemoteFileLocation>;
  moveEntry(
    entry: RemoteEntryLocation,
    parent: RemoteFileLocation,
    signal?: AbortSignal,
  ): Promise<RemoteFileLocation>;
  removeEntry(entry: RemoteEntryLocation, signal?: AbortSignal): Promise<void>;
  /** One captured listing. Breaking the loop releases it; omit path for the provider default. */
  list(
    location: { binding: string; path?: string },
    signal?: AbortSignal,
  ): AsyncIterable<RemoteDirectoryPage>;
  readText(
    location: RemoteFileLocation,
    signal?: AbortSignal,
  ): Promise<RemoteTextDocument>;
  saveText(
    document: RemoteTextDocument,
    text: string,
    signal?: AbortSignal,
  ): Promise<RemoteTextDocument>;
  createText(
    destination: {
      binding: string;
      parent: string;
      name: string;
      text: string;
    },
    signal?: AbortSignal,
  ): Promise<RemoteTextDocument>;
}
export function appFileClient(peer: RpcPeer): AppFilesAPI {
  return Object.freeze({
    makeDirectory: async ({ binding, parent, name }, signal) =>
      (await peer.call(
        "system.files.makeDirectory",
        { binding, parent, name },
        signal,
      )) as unknown as RemoteFileLocation,
    renameEntry: async ({ binding, path, revision }, name, signal) =>
      (await peer.call(
        "system.files.renameEntry",
        { binding, path, revision, name },
        signal,
      )) as unknown as RemoteFileLocation,
    moveEntry: async ({ binding, path, revision }, parent, signal) =>
      (await peer.call(
        "system.files.moveEntry",
        {
          binding,
          path,
          revision,
          parent: parent.path,
          parentBinding: parent.binding,
        },
        signal,
      )) as unknown as RemoteFileLocation,
    removeEntry: async ({ binding, path, revision }, signal) => {
      await peer.call(
        "system.files.removeEntry",
        { binding, path, revision },
        signal,
      );
    },
    async *list({ binding, path }, signal) {
      const id = crypto.randomUUID();
      let closing: Promise<unknown> | undefined;
      const close = () =>
        (closing ??= peer
          .call("system.files.listClose", { id })
          .catch(() => {}));
      const cancel = () => {
        void close();
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        let result = (await peer.call(
          "system.files.listStart",
          { id, binding, path: path ?? null },
          signal,
        )) as unknown as { directory: RemoteDirectoryPage; done: boolean };
        while (true) {
          yield result.directory;
          if (result.done) break;
          result = (await peer.call(
            "system.files.listNext",
            { id },
            signal,
          )) as unknown as { directory: RemoteDirectoryPage; done: boolean };
        }
      } finally {
        // The caller's aborted signal must not prevent cleanup of a dispatched start.
        signal?.removeEventListener("abort", cancel);
        await close();
      }
    },
    readText: async ({ binding, path }, signal) =>
      (await peer.call(
        "system.files.readText",
        { binding, path },
        signal,
      )) as unknown as RemoteTextDocument,
    saveText: async ({ binding, path, revision }, text, signal) =>
      (await peer.call(
        "system.files.saveText",
        { binding, path, revision, text },
        signal,
      )) as unknown as RemoteTextDocument,
    createText: async ({ binding, parent, name, text }, signal) =>
      (await peer.call(
        "system.files.createText",
        { binding, parent, name, text },
        signal,
      )) as unknown as RemoteTextDocument,
  } satisfies AppFilesAPI);
}
