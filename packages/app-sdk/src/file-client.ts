// SPDX-License-Identifier: MPL-2.0
import type { TextDocument } from "./files.js";
import type { RpcPeer } from "./rpc.js";

/** Capture environment.binding before choosing or retaining a provider location. */
export interface RemoteFileLocation {
  binding: string;
  path: string;
}
/** Keep this snapshot with the draft. Never substitute a new binding or revision. */
export interface RemoteTextDocument extends TextDocument {
  binding: string;
}
export interface AppFilesAPI {
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
