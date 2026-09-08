// SPDX-License-Identifier: MPL-2.0
import type { Json } from "./rpc.js";

/** Local to this app identity, shared by its windows and installed versions. */
export interface AppValue {
  readonly revision: string;
  readonly value: Json;
}
export interface StoragePage {
  readonly keys: readonly string[];
  /** Pass as `after` for the next page. Listing reflects live committed state. */
  readonly next: string | null;
}
export interface AppStorageAPI {
  get(key: string, signal?: AbortSignal): Promise<AppValue | null>;
  /** null means create only. A read revision is required for replacement. */
  put(
    key: string,
    value: Json,
    expectedRevision: string | null,
    signal?: AbortSignal,
  ): Promise<AppValue>;
  remove(
    key: string,
    expectedRevision: string | null,
    signal?: AbortSignal,
  ): Promise<void>;
  list(
    options?: { after?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<StoragePage>;
}
