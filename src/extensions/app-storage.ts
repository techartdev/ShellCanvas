// SPDX-License-Identifier: MPL-2.0
import { isJsonValue, RpcError, type Json, type RpcMethod } from "./rpc";
import type { AppStorageBackend, AppValue, StorageBucket } from "./storage-api";

function key(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 256 ||
    value.includes("\0")
  )
    throw new RpcError(
      "invalid",
      "Storage keys must contain 1–256 characters without NUL.",
    );
}
function revision(value: unknown): asserts value is string | null {
  if (
    value !== null &&
    (typeof value !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(value))
  )
    throw new RpcError(
      "invalid",
      "Supply the last read revision, or null to create a value.",
    );
}
function record(params: Json, fields: readonly string[]) {
  if (
    !params ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    Object.keys(params).some((name) => !fields.includes(name))
  )
    throw new RpcError("invalid", "Invalid storage options.");
  return params;
}
export function appStorageMethods(
  owner: string,
  storage: AppStorageBackend,
): ReadonlyMap<string, RpcMethod> {
  const methods = new Map<string, RpcMethod>();
  for (const [namespace, bucket] of [
    ["storage", "data"],
    ["settings", "settings"],
  ] as const) {
    const add = (name: string, invoke: RpcMethod["invoke"]) =>
      methods.set(`system.${namespace}.${name}`, {
        grants: ["system.storage"],
        invoke,
      });
    add("get", async (params, signal) => {
      const args = record(params, ["key"]);
      key(args.key);
      return (await storage.get(
        owner,
        bucket,
        args.key,
        signal,
      )) as unknown as Json;
    });
    add("put", async (params, signal) => {
      const args = record(params, ["key", "value", "expectedRevision"]);
      key(args.key);
      revision(args.expectedRevision);
      if (
        !Object.hasOwn(args, "value") ||
        JSON.stringify(args.value).length > 1024 * 1024
      )
        throw new RpcError(
          "invalid",
          "Store at most 1 Mi UTF-16 units per value; use file services for documents and bulk data.",
        );
      return (await storage.put(
        owner,
        bucket,
        args.key,
        args.value,
        args.expectedRevision,
        signal,
      )) as unknown as Json;
    });
    add("remove", async (params, signal) => {
      const args = record(params, ["key", "expectedRevision"]);
      key(args.key);
      revision(args.expectedRevision);
      await storage.remove(
        owner,
        bucket,
        args.key,
        args.expectedRevision,
        signal,
      );
      return null;
    });
    add("list", async (params, signal) => {
      const args = record(params, ["after", "limit"]);
      if (args.after !== undefined) key(args.after);
      const limit = args.limit === undefined ? 100 : args.limit;
      if (
        typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200
      )
        throw new RpcError("invalid", "List between 1 and 200 keys per page.");
      return (await storage.list(
        owner,
        bucket,
        args.after as string | undefined,
        limit,
        signal,
      )) as unknown as Json;
    });
  }
  return methods;
}

function canceled(signal: AbortSignal) {
  if (signal.aborted)
    throw new RpcError("aborted", "Storage operation canceled.");
}
function stored(value: unknown): AppValue | null {
  if (value === undefined) return null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("revision" in value) ||
    !("value" in value) ||
    !isJsonValue(value.value)
  )
    throw new RpcError(
      "failed",
      "The saved app value is invalid. It has been preserved.",
    );
  revision(value.revision);
  if (!value.revision)
    throw new RpcError(
      "failed",
      "The saved app value has no revision. It has been preserved.",
    );
  return { revision: value.revision, value: value.value };
}

/** Atomic key-level CAS in the host origin. No app frame gets database access. */
export function indexedAppStorage(
  name = "shellcanvas-app-data",
): AppStorageBackend {
  let opening: Promise<IDBDatabase> | undefined;
  const database = () =>
    (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      let failed = false;
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("values");
      const fail = (message: string) => {
        failed = true;
        opening = undefined;
        reject(new RpcError("unavailable", message));
      };
      request.onerror = () =>
        fail(
          "App storage could not be opened. Existing data has not been replaced.",
        );
      request.onblocked = () =>
        fail("Another desktop is blocking an app storage upgrade.");
      request.onsuccess = () => {
        const db = request.result;
        if (failed) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          opening = undefined;
        };
        resolve(db);
      };
    }));
  async function transaction<T>(
    mode: IDBTransactionMode,
    signal: AbortSignal,
    run: (
      store: IDBObjectStore,
      result: (value: T) => void,
      fail: (error: unknown) => void,
    ) => void,
  ): Promise<T> {
    canceled(signal);
    const db = await database();
    canceled(signal);
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction("values", mode);
      let value: T, failure: unknown;
      const abort = () => {
        failure = new RpcError("aborted", "Storage operation canceled.");
        try {
          tx.abort();
        } catch {
          /* Already committed: cancellation cannot undo it. */
        }
      };
      const cleanup = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      tx.oncomplete = () => {
        cleanup();
        resolve(value);
      };
      tx.onabort = () => {
        cleanup();
        reject(
          failure ??
            new RpcError(
              "failed",
              "App storage could not commit. Check available disk space and storage access.",
            ),
        );
      };
      const fail = (error: unknown) => {
        failure = error;
        tx.abort();
      };
      try {
        run(
          tx.objectStore("values"),
          (result) => {
            value = result;
          },
          fail,
        );
      } catch (error) {
        fail(error);
      }
    });
  }
  const address = (owner: string, bucket: StorageBucket, name: string) => [
    owner,
    bucket,
    name,
  ];
  const change = async (
    owner: string,
    bucket: StorageBucket,
    key: string,
    expected: string | null,
    value: Json | undefined,
    signal: AbortSignal,
  ) =>
    transaction<AppValue | null>("readwrite", signal, (store, result, fail) => {
      const path = address(owner, bucket, key);
      const read = store.get(path);
      read.onsuccess = () => {
        try {
          const current = stored(read.result);
          if ((current?.revision ?? null) !== expected)
            throw new RpcError(
              "busy",
              "This value changed in another window or app version. Read it again before saving.",
            );
          const next =
            value === undefined
              ? null
              : { revision: crypto.randomUUID(), value };
          if (next) store.put(next, path);
          else store.delete(path);
          result(next);
        } catch (error) {
          fail(error);
        }
      };
    });
  return {
    get: (owner, bucket, key, signal) =>
      transaction("readonly", signal, (store, result, fail) => {
        const read = store.get(address(owner, bucket, key));
        read.onsuccess = () => {
          try {
            result(stored(read.result));
          } catch (error) {
            fail(error);
          }
        };
      }),
    put: async (owner, bucket, key, value, expected, signal) =>
      (await change(owner, bucket, key, expected, value, signal))!,
    remove: async (owner, bucket, key, expected, signal) => {
      await change(owner, bucket, key, expected, undefined, signal);
    },
    list: (owner, bucket, after, limit, signal) =>
      transaction("readonly", signal, (store, result) => {
        const keys: string[] = [];
        // Arrays sort after strings, giving an exact prefix range for arbitrary Unicode keys.
        const range = IDBKeyRange.bound(
          after === undefined ? [owner, bucket] : [owner, bucket, after],
          [owner, bucket, []],
          true,
          true,
        );
        const read = store.openKeyCursor(range);
        read.onsuccess = () => {
          const cursor = read.result;
          if (!cursor) {
            result({ keys, next: null });
            return;
          }
          if (keys.length === limit) {
            result({ keys, next: keys.at(-1)! });
            return;
          }
          keys.push((cursor.key as string[])[2]);
          cursor.continue();
        };
      }),
  };
}
