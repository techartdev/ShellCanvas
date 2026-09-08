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
it("persists installed packages and grants, and pins existing windows across updates", async () => {
  const saved = storage();
  const catalog = new AppCatalog(saved.api);
  await catalog.load();
  const review = await catalog.review(raw());
  expect(review.digest).toMatch(/^[a-f0-9]{64}$/);
  const first = await catalog.install(review, ["system.dialogs"]);
  const window = catalog.launch(first.package.id);
  const updated = await catalog.install(
    await catalog.review(raw("2.0.0", ["system.dialogs", "files.read"])),
    [],
  );
  expect(updated.generation).not.toBe(first.generation);
  expect(window.installed.package.version).toBe("1.0.0");
  expect(window.installed.grants).toEqual(["system.dialogs"]);
  expect(window.closed).toBe(false);
  const next = catalog.launch(first.package.id);
  expect(next.installed.package.version).toBe("2.0.0");
  expect(next.installed.grants).toEqual([]);
  const reopened = new AppCatalog(saved.api);
  await reopened.load();
  expect(reopened.snapshot()[0]).toEqual(updated);
  expect(Object.isFrozen(reopened.snapshot()[0].package)).toBe(true);
  window.close();
  next.close();
});
it("disables new launches without destroying existing work and refuses removal until all generations close", async () => {
  const catalog = new AppCatalog(storage().api);
  await catalog.load();
  const first = await catalog.install(await catalog.review(raw()), []);
  const old = catalog.launch(first.package.id);
  const current = await catalog.install(await catalog.review(raw("2.0.0")), []);
  await catalog.setEnabled(current.package.id, current.generation, false);
  expect(() => catalog.launch(current.package.id)).toThrow("disabled");
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
  vi.mocked(saved.api.compareAndSet).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const removing = catalog.remove(installed.package.id, installed.generation);
  await Promise.resolve();
  expect(() => catalog.launch(installed.package.id)).toThrow("being saved");
  finish();
  await removing;
  expect(() => catalog.launch(installed.package.id)).toThrow(
    "no longer installed",
  );
});
