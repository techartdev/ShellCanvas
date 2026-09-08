// SPDX-License-Identifier: MPL-2.0
import type { FileEntry, TextDocument } from "./sdk";

export interface DialogControl {
  signal?: AbortSignal;
}
export interface MessageBoxOptions {
  title: string;
  message: string;
  kind?: "info" | "warning" | "error";
  buttons?: readonly { id: string; label: string; destructive?: boolean }[];
  defaultId?: string;
  cancelId?: string;
}
export interface OpenFileOptions {
  title?: string;
  directory?: string;
  kind?: "file" | "directory";
  multiple?: boolean;
  /** Filename suffixes, e.g. [".txt", ".json"]. Folders remain navigable. */
  extensions?: readonly string[];
}
export interface SaveFileOptions {
  title?: string;
  directory?: string;
  name?: string;
}
/** A selection, not a write or overwrite grant. Locations are opaque. */
export interface FileSaveSelection {
  parent: string;
  name: string;
  existing?: Readonly<FileEntry>;
}
export interface SystemDialogs {
  messageBox(
    options: MessageBoxOptions,
    control?: DialogControl,
  ): Promise<string | null>;
  openFile(
    options?: OpenFileOptions,
    control?: DialogControl,
  ): Promise<readonly FileEntry[] | null>;
  saveFile(
    options?: SaveFileOptions,
    control?: DialogControl,
  ): Promise<FileSaveSelection | null>;
}
/** Every desktop window receives its own lifetime-bound system handle. */
export interface SystemAPI {
  readonly apiVersion: 1;
  readonly dialogs: SystemDialogs;
  readonly files: {
    /** Pick a destination, review replacement, then perform a revision-checked text save. */
    saveTextAs(
      options: SaveFileOptions & { text: string; allowReplace?: boolean },
      control?: DialogControl,
    ): Promise<TextDocument | null>;
  };
}
export class SystemError extends Error {
  constructor(
    public readonly code:
      "aborted" | "closed" | "unavailable" | "invalid" | "busy",
    message: string,
  ) {
    super(message);
    this.name = "SystemError";
  }
}
