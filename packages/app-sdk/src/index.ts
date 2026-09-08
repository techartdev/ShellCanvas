// SPDX-License-Identifier: MPL-2.0
export { connectToShellCanvas } from "./client.js";
export type { ExtensionClient } from "./client.js";
export { RpcError } from "./rpc.js";
export type { RpcCode, Json } from "./rpc.js";
export { SystemError } from "./system-api.js";
export type {
  SystemAPI,
  SystemDialogs,
  MessageBoxOptions,
  OpenFileOptions,
  SaveFileOptions,
  FileSaveSelection,
  DialogControl,
} from "./system-api.js";
export type { FileEntry, TextDocument } from "./files.js";
export type {
  AppFilesAPI,
  RemoteFileLocation,
  RemoteEntryLocation,
  RemoteTextDocument,
  RemoteDirectoryPage,
} from "./file-client.js";
export type { AppDocumentState } from "./window-api.js";
export type { AppStorageAPI, AppValue, StoragePage } from "./storage-api.js";
export type {
  AppEnvironment,
  ServiceMethodInfo,
  AppEvent,
  AppEventBatch,
  AppEventsAPI,
} from "./environment-api.js";
export type { AppClipboardAPI } from "./clipboard-client.js";
export type { AppConsoleAPI, RemoteConsole } from "./console-client.js";
