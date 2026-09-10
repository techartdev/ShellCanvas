// SPDX-License-Identifier: MPL-2.0
import { it, expect } from "vitest";
import { AppCatalog, type CatalogSnapshot } from "./catalog";
import { DesktopRuntime } from "./desktop-runtime";
import { initialDesktop } from "../desktop";

it("retains incompatible saved apps in the launcher but refuses new windows", async () => {
  let value: CatalogSnapshot | null = null;
  const storage = {
    read: async () => value,
    compareAndSet: async (_: string | null, next: CatalogSnapshot) => {
      value = next;
    },
  };
  const desktop = new AppCatalog(storage, async () => ({
    platform: "windows",
  }));
  await desktop.load();
  const entry = await desktop.install(
    await desktop.review(
      JSON.stringify({
        format: 1,
        kind: "app",
        id: "org.example.desktop",
        title: "Desktop tool",
        version: "1.0.0",
        permissions: [],
        script: "void 0",
        style: "",
        clientPlatforms: ["windows", "linux", "macos"],
      }),
    ),
    [],
  );
  const mobile = new AppCatalog(storage, async () => ({ platform: "android" }));
  const runtime = new DesktopRuntime(mobile, []);
  await mobile.load();
  expect(runtime.disabledReason(entry.package.id)).toContain(
    "Not available on Android",
  );
  expect(runtime.snapshot().some((app) => app.id === entry.package.id)).toBe(
    true,
  );
  await expect(
    runtime.prepare(
      { type: "new", id: entry.package.id },
      initialDesktop(runtime.snapshot()),
    ),
  ).rejects.toThrow("Not available on Android");
});
