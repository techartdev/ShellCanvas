// SPDX-License-Identifier: MPL-2.0
import { indexedAppStorage } from "../../src/extensions/app-storage";
/** Real IndexedDB transactions; fixture namespaces only, never the normal app data DB. */
export async function storageProbe() {
  const name = "shellcanvas-storage-probe";
  const one = indexedAppStorage(name),
    two = indexedAppStorage(name);
  const signal = new AbortController().signal;
  const owner = "org.shellcanvas.storage-probe",
    foreign = "org.shellcanvas.other-probe";
  const clean = async () => {
    for (const identity of [owner, foreign])
      for (const bucket of ["data", "settings"] as const) {
        let page;
        do {
          page = await one.list(identity, bucket, undefined, 200, signal);
          for (const key of page.keys) {
            const value = await one.get(identity, bucket, key, signal);
            await one.remove(identity, bucket, key, value!.revision, signal);
          }
        } while (page.next);
      }
  };
  await clean();
  try {
    const saved = await one.put(
      owner,
      "data",
      "note",
      { text: "kept" },
      null,
      signal,
    );
    const persisted = await two.get(owner, "data", "note", signal);
    const isolated =
      (await two.get(foreign, "data", "note", signal)) === null &&
      (await two.get(owner, "settings", "note", signal)) === null;
    const races = await Promise.allSettled([
      one.put(owner, "data", "note", "first", saved.revision, signal),
      two.put(owner, "data", "note", "second", saved.revision, signal),
    ]);
    const winner = await one.get(owner, "data", "note", signal);
    let staleDelete = false;
    try {
      await two.remove(owner, "data", "note", saved.revision, signal);
    } catch (error) {
      staleDelete = (error as { code: string }).code === "busy";
    }
    const canceled = new AbortController();
    canceled.abort();
    let canceledWrite = false;
    try {
      await one.put(owner, "data", "canceled", true, null, canceled.signal);
    } catch (error) {
      canceledWrite = (error as { code: string }).code === "aborted";
    }
    for (const key of ["__proto__", "a", "z", "\uffff-last"])
      await one.put(owner, "data", key, false, null, signal);
    const keys: string[] = [];
    let after: string | undefined;
    do {
      const page = await two.list(owner, "data", after, 2, signal);
      keys.push(...page.keys);
      after = page.next ?? undefined;
    } while (after);
    return {
      storageSeparateConnection:
        persisted?.revision === saved.revision &&
        JSON.stringify(persisted.value) === '{"text":"kept"}',
      storageIsolated: isolated,
      storageAtomicConflict:
        races.filter((result) => result.status === "fulfilled").length === 1 &&
        races.some(
          (result) =>
            result.status === "rejected" && result.reason.code === "busy",
        ) &&
        winner?.revision !== saved.revision,
      storageStaleDeleteRefused: staleDelete,
      storageCanceledBeforeWrite:
        canceledWrite &&
        (await two.get(owner, "data", "canceled", signal)) === null,
      storagePagination:
        JSON.stringify(keys) ===
        JSON.stringify(["__proto__", "a", "note", "z", "\uffff-last"]),
    };
  } finally {
    await clean();
  }
}
