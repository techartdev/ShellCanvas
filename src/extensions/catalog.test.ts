// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import {
  AppCatalog,
  parseCatalog,
  type CatalogSnapshot,
  type CatalogStorage,
} from "./catalog";
const raw = (version = "1.0.0", permissions = ["system.dialogs"]) =>
  JSON.stringify({
    format: 1,
    kind: "app",
    id: "org.example.notes",
    version,
    title: "Notes",
    permissions,
    script: `console.log('${version}')`,
    style: "",
  });

it("enforces client compatibility for install, updates, enable and persisted launches", async () => {
  const saved = storage();
  const desktop = new AppCatalog(saved.api, async () => ({
    platform: "windows",
  }));
  const android = new AppCatalog(saved.api, async () => ({
    platform: "android",
  }));
  await Promise.all([desktop.load(), android.load()]);
  const restricted = JSON.stringify({
    ...JSON.parse(raw()),
    clientPlatforms: ["windows", "macos", "linux"],
  });
  const review = await android.review(restricted);
  expect(android.compatibilityReason(review.package)).toContain(
    "Not available on Android",
  );
  await expect(android.install(review, [])).rejects.toThrow(
    "Not available on Android",
  );
  expect(saved.api.compareAndSet).not.toHaveBeenCalled();
  const entry = await desktop.install(await desktop.review(restricted), []);
  const lease = await desktop.launch(entry.package.id);
  expect(lease.client).toEqual({ platform: "windows" });
  lease.close();
  await android.load();
  expect(android.snapshot()).toHaveLength(1);
  await expect(android.launch(entry.package.id)).rejects.toThrow(
    "Not available on Android",
  );
  await android.setEnabled(entry.package.id, entry.generation, false);
  await expect(
    android.setEnabled(entry.package.id, entry.generation, true),
  ).rejects.toThrow("Not available on Android");
  // Portable replacement can be installed and launched on either client.
  const portable = await android.install(
    await android.review(raw("2.0.0")),
    [],
  );
  const mobileLease = await android.launch(portable.package.id);
  expect(mobileLease.client.platform).toBe("android");
  mobileLease.close();
  await expect(
    android.install(await android.review(restricted), []),
  ).rejects.toThrow("Not available on Android");
  expect(android.snapshot()[0].package.version).toBe("2.0.0");
  await android.remove(portable.package.id, portable.generation);
  expect(android.snapshot()).toHaveLength(0);
});
function storage() {
  let value: unknown = null;
  const api: CatalogStorage = {
    read: async () => structuredClone(value),
    compareAndSet: vi.fn(async (expected, next) => {
      if (((value as CatalogSnapshot | null)?.revision ?? null) !== expected)
        throw new Error("Concurrent catalog change");
      value = structuredClone(next);
    }),
  };
  return {
    api,
    corrupt: () => {
      value = { format: 2 };
    },
  };
}

it("retains verified repository provenance and rejects a mismatched artifact hash", async () => {
  const catalog = new AppCatalog(storage().api);
  await catalog.load();
  const sha256 = [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw())),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const source = { owner: "example", repository: "notes", ref: "main", sha256 };
  await expect(
    catalog.review(raw(), { ...source, sha256: "a".repeat(64) }),
  ).rejects.toThrow("fingerprint");
  const app = await catalog.install(await catalog.review(raw(), source), []);
  await catalog.load();
  expect(catalog.snapshot()[0].source).toEqual(source);
  expect(app.source).toEqual(source);
  const lease = await catalog.launch(app.package.id);
  await catalog.install(await catalog.review(raw("2.0.0")), []);
  expect(lease.installed.source).toEqual(source);
  expect(catalog.snapshot()[0].source).toBeUndefined();
  lease.close();
});

it("revalidates stale launchers and retains leases across another catalog's update and disable", async () => {
  const saved = storage();
  const locks = new Map<string, number>();
  saved.api.hold = async (id, mode) => {
    const count = locks.get(id) ?? 0;
    if (count < 0 || (mode === "exclusive" && count > 0))
      throw new Error("running windows in another desktop");
    locks.set(id, mode === "shared" ? count + 1 : -1);
    return () => {
      locks.set(id, mode === "shared" ? locks.get(id)! - 1 : 0);
    };
  };
  const one = new AppCatalog(saved.api),
    two = new AppCatalog(saved.api);
  await Promise.all([one.load(), two.load()]);
  const first = await one.install(await one.review(raw()), ["system.dialogs"]);
  const old = await two.launch(first.package.id); // Its loaded catalog was empty.
  const second = await one.install(await one.review(raw("2.0.0")), []);
  const current = await two.launch(first.package.id);
  expect(old.installed.package.version).toBe("1.0.0");
  expect(old.installed.grants).toEqual(["system.dialogs"]);
  expect(current.installed.package.version).toBe("2.0.0");
  await one.setEnabled(second.package.id, second.generation, false);
  await expect(two.launch(second.package.id)).rejects.toThrow("disabled");
  expect(locks.get(second.package.id)).toBe(2); // Rejected launch released its lock.
  await expect(
    one.remove(second.package.id, second.generation),
  ).rejects.toThrow("another desktop");
  expect(old.closed).toBe(false);
  old.close();
  current.close();
  await one.remove(second.package.id, second.generation);
  await expect(two.launch(second.package.id)).rejects.toThrow(
    "no longer installed",
  );
  expect(locks.get(second.package.id)).toBe(0);
});

it("refreshes from invalidations without replacing unchanged snapshots or losing state on corruption", async () => {
  const saved = storage();
  const changes = new Set<() => void>();
  saved.api.subscribe = (fn) => {
    changes.add(fn);
    return () => {
      changes.delete(fn);
    };
  };
  const catalog = new AppCatalog(saved.api),
    writer = new AppCatalog(saved.api);
  await writer.load();
  const errors = vi.fn();
  const stop = catalog.watch(errors);
  await catalog.load();
  const publish = vi.fn();
  catalog.subscribe(publish);
  const first = await writer.install(await writer.review(raw()), []);
  for (const fn of changes) fn();
  await vi.waitFor(() => expect(catalog.snapshot()[0]).toEqual(first));
  const snapshot = catalog.snapshot();
  await catalog.load();
  expect(catalog.snapshot()).toBe(snapshot);
  expect(publish).toHaveBeenCalledOnce();
  saved.corrupt();
  for (const fn of changes) fn();
  await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce());
  expect(catalog.snapshot()).toBe(snapshot);
  stop();
  expect(changes.size).toBe(0);
});
it("persists installed packages and grants, and pins existing windows across updates", async () => {
  const saved = storage();
  const catalog = new AppCatalog(saved.api);
  await catalog.load();
  const review = await catalog.review(raw());
  expect(review.digest).toMatch(/^[a-f0-9]{64}$/);
  const first = await catalog.install(review, ["system.dialogs"]);
  const window = await catalog.launch(first.package.id);
  const updated = await catalog.install(
    await catalog.review(raw("2.0.0", ["system.dialogs", "files.read"])),
    [],
  );
  expect(updated.generation).not.toBe(first.generation);
  expect(updated.principal).toBe(first.principal);
  expect(window.installed.package.version).toBe("1.0.0");
  expect(window.installed.grants).toEqual(["system.dialogs"]);
  expect(window.closed).toBe(false);
  const next = await catalog.launch(first.package.id);
  expect(next.installed.package.version).toBe("2.0.0");
  expect(next.installed.grants).toEqual([]);
  const reopened = new AppCatalog(saved.api);
  await reopened.load();
  expect(reopened.snapshot()[0]).toEqual(updated);
  expect(Object.isFrozen(reopened.snapshot()[0].package)).toBe(true);
  window.close();
  next.close();
});
it("preserves an installation principal across updates and rotates it after removal", async () => {
  const catalog = new AppCatalog(storage().api);
  await catalog.load();
  const first = await catalog.install(await catalog.review(raw()), []);
  const updated = await catalog.install(
    await catalog.review(raw("2.0.0")),
    [],
  );
  expect(updated.principal).toBe(first.principal);
  await catalog.remove(updated.package.id, updated.generation);
  const reinstalled = await catalog.install(await catalog.review(raw()), []);
  expect(reinstalled.principal).not.toBe(first.principal);
});
it("disables new launches without destroying existing work and refuses removal until all generations close", async () => {
  const catalog = new AppCatalog(storage().api);
  await catalog.load();
  const first = await catalog.install(await catalog.review(raw()), []);
  const old = await catalog.launch(first.package.id);
  const current = await catalog.install(await catalog.review(raw("2.0.0")), []);
  await catalog.setEnabled(current.package.id, current.generation, false);
  await expect(catalog.launch(current.package.id)).rejects.toThrow("disabled");
  expect(old.closed).toBe(false);
  await expect(
    catalog.remove(current.package.id, current.generation),
  ).rejects.toMatchObject({ code: "busy" });
  const closed = vi.fn();
  old.onClose(closed);
  old.close();
  old.close();
  expect(closed).toHaveBeenCalledTimes(1);
  await catalog.remove(current.package.id, current.generation);
  expect(catalog.snapshot()).toEqual([]);
});
it("rejects stale and reused reviews, undeclared grants and stale management controls", async () => {
  const catalog = new AppCatalog(storage().api);
  await catalog.load();
  const a = await catalog.review(raw());
  const b = await catalog.review(raw("2.0.0"));
  expect(() => catalog.install(a, ["files.read"])).toThrow("declared");
  const installed = await catalog.install(a, []);
  await expect(catalog.install(a, [])).rejects.toMatchObject({
    code: "invalid",
  });
  await expect(catalog.install(b, [])).rejects.toThrow("changed after review");
  const next = await catalog.review(raw("2.0.0"));
  await catalog.setEnabled(installed.package.id, installed.generation, false);
  await expect(catalog.install(next, [])).rejects.toThrow(
    "changed after review",
  );
  await expect(
    catalog.remove(installed.package.id, "foreign-generation"),
  ).rejects.toThrow("changed");
});
it("preserves the current state on storage failure and does not reset a corrupt catalog", async () => {
  const saved = storage();
  const catalog = new AppCatalog(saved.api);
  await catalog.load();
  await catalog.install(await catalog.review(raw()), []);
  const before = catalog.snapshot();
  vi.mocked(saved.api.compareAndSet).mockRejectedValueOnce(
    new Error("Disk full"),
  );
  const review = await catalog.review(raw("2.0.0"));
  await expect(catalog.install(review, [])).rejects.toThrow("Disk full");
  expect(catalog.snapshot()).toBe(before);
  await catalog.install(review, []);
  const after = catalog.snapshot();
  saved.corrupt();
  await expect(catalog.load()).rejects.toThrow("unsupported format");
  expect(catalog.snapshot()).toBe(after);
  expect(parseCatalog(null)).toBeNull();
  const malformed = {
    format: 1,
    revision: "rev",
    apps: [{ ...after[0], grants: ["undeclared.permission"] }],
  };
  expect(() => parseCatalog(malformed)).toThrow("declared");
});
it("uses atomic compare-and-set to reject another desktop's stale writes", async () => {
  const saved = storage();
  const one = new AppCatalog(saved.api);
  const two = new AppCatalog(saved.api);
  await Promise.all([one.load(), two.load()]);
  const secondReview = await two.review(raw("2.0.0"));
  await one.install(await one.review(raw()), []);
  await expect(two.install(secondReview, [])).rejects.toThrow("Concurrent");
  expect(two.snapshot()).toEqual([]);
  await two.load();
  await expect(two.install(secondReview, [])).rejects.toThrow(
    "changed after review",
  );
  await two.install(await two.review(raw("2.0.0")), []);
});
it("blocks launch while a remove transaction is pending, avoiding an untracked live window", async () => {
  const saved = storage();
  const catalog = new AppCatalog(saved.api);
  await catalog.load();
  const installed = await catalog.install(await catalog.review(raw()), []);
  let finish!: () => void;
  const commit = vi.mocked(saved.api.compareAndSet).getMockImplementation()!;
  vi.mocked(saved.api.compareAndSet).mockImplementationOnce(
    async (expected, next) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await commit(expected, next);
    },
  );
  const removing = catalog.remove(installed.package.id, installed.generation);
  await Promise.resolve();
  const opening = catalog.launch(installed.package.id);
  const rejected = expect(opening).rejects.toThrow("no longer installed");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  finish();
  await removing;
  await rejected;
});
