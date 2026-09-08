// SPDX-License-Identifier: MPL-2.0
import type { Json } from "./rpc";
import type {
  AppValue,
  StoragePage,
} from "../../packages/app-sdk/src/storage-api";
export type {
  AppValue,
  StoragePage,
  AppStorageAPI,
} from "../../packages/app-sdk/src/storage-api";
export type StorageBucket = "data" | "settings";
/** Only the trusted host supplies the owner. Never forward an app-supplied identity. */
export interface AppStorageBackend {
  get(
    owner: string,
    bucket: StorageBucket,
    key: string,
    signal: AbortSignal,
  ): Promise<AppValue | null>;
  put(
    owner: string,
    bucket: StorageBucket,
    key: string,
    value: Json,
    expected: string | null,
    signal: AbortSignal,
  ): Promise<AppValue>;
  remove(
    owner: string,
    bucket: StorageBucket,
    key: string,
    expected: string | null,
    signal: AbortSignal,
  ): Promise<void>;
  list(
    owner: string,
    bucket: StorageBucket,
    after: string | undefined,
    limit: number,
    signal: AbortSignal,
  ): Promise<StoragePage>;
}
