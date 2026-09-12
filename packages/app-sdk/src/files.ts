// SPDX-License-Identifier: MPL-2.0
export interface TextDocument {
  path: string;
  name: string;
  parent: string | null;
  text: string;
  revision: string;
  writable: boolean;
  /** Existing-file saves need explicit acceptance of interrupted-write risk. */
  saveRequiresConfirmation?: boolean;
}
export interface FileEntry {
  revision?: string;
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink";
  size: number;
  modified: number | null;
}
