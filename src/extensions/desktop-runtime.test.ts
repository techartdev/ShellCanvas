// SPDX-License-Identifier: MPL-2.0
import { expect, it } from "vitest";
import { initialDesktop, updateDesktop } from "../desktop";
import { AppCatalog, type CatalogSnapshot } from "./catalog";
import { DesktopRuntime } from "./desktop-runtime";
async function setup() {
  let saved: CatalogSnapshot | null = null;
  const catalog = new AppCatalog({
    read: async () => saved,
    compareAndSet: async (_, next) => {
      saved = next;
    },
  });
  const runtime = new DesktopRuntime(catalog, []);
  await catalog.load();
  const install = async (version: string, grants: string[] = []) =>
    catalog.install(
      await catalog.review(
        JSON.stringify({
          format: 1,
          kind: "app",
          id: "org.example.notes",
          title: "Notes",
          version,
          permissions: [
            "system.dialogs",
            "files.read",
            "system.console",
            "host.settings.read",
            "host.settings.write",
          ],
          script: "void 0",
          style: "",
        }),
      ),
      grants,
    );
  return { catalog, runtime, install };
}
it("maps the namespaced console permission to a host capability without granting unrelated services", async () => {
  const { runtime, install } = await setup();
  await install("1.0.0", ["system.console"]);
  const descriptor = runtime
    .snapshot()
    .find((app) => app.id === "org.example.notes")!;
  expect(descriptor.scope).toBe("host");
  expect(descriptor.optional).toEqual(["terminal"]);
  expect(descriptor.requires).toEqual([]);
  runtime.closeAll();
});
it("maps each remote settings grant to its host capability without changing approved grants", async () => {
  for (const grant of ["host.settings.read", "host.settings.write"]) {
    const { runtime, install, catalog } = await setup();
    await install("1.0.0", [grant]);
    expect(
      runtime.snapshot().find((app) => app.id === "org.example.notes")
        ?.optional,
    ).toEqual(["host.settings"]);
    expect(catalog.snapshot()[0].grants).toEqual([grant]);
    runtime.closeAll();
  }
});
it("pins running descriptors and grants while new desktop windows use the installed update", async () => {
  const { runtime, install } = await setup();
  await install("1.0.0", ["files.read"]);
  let state = initialDesktop(runtime.snapshot());
  state = updateDesktop(
    state,
    runtime.prepare({ type: "new", id: "org.example.notes" }, state),
    runtime.snapshot(),
  );
  const old = state.instances[state.open[0]];
  const original = runtime.resolve(old)!;
  await install("2.0.0");
  state = updateDesktop(
    state,
    runtime.prepare({ type: "new", id: "org.example.notes" }, state),
    runtime.snapshot(),
  );
  expect(runtime.resolve(old)).toBe(original);
  expect(original.subtitle).toBe("Version 1.0.0");
  expect(original.optional).toEqual(["files.read"]);
  expect(runtime.resolve(state.instances[state.open[1]])!.subtitle).toBe(
    "Version 2.0.0",
  );
  expect(runtime.resolve(state.instances[state.open[1]])!.optional).toEqual([]);
  expect(state.instances[state.open[1]].extension).not.toBe(old.extension);
  runtime.closeAll();
});
it("restores disabled app windows, rejects new launches, and releases ownership before removal", async () => {
  const { runtime, catalog, install } = await setup();
  const entry = await install("1.0.0");
  let state = initialDesktop(runtime.snapshot());
  state = updateDesktop(
    state,
    runtime.prepare({ type: "new", id: entry.package.id }, state),
    runtime.snapshot(),
  );
  const id = state.open[0];
  await catalog.setEnabled(entry.package.id, entry.generation, false);
  expect(
    runtime.prepare({ type: "open", id: entry.package.id }, state),
  ).toEqual({ type: "focus", id });
  expect(() =>
    runtime.prepare({ type: "new", id: entry.package.id }, state),
  ).toThrow("disabled");
  await expect(
    catalog.remove(entry.package.id, entry.generation),
  ).rejects.toThrow("running windows");
  runtime.close(state.instances[id].extension!);
  runtime.close(state.instances[id].extension!);
  await catalog.remove(entry.package.id, entry.generation);
  expect(runtime.resolve(state.instances[id])).toBeUndefined();
  expect(runtime.snapshot().some((app) => app.id === entry.package.id)).toBe(
    false,
  );
});
it("keeps runtime lease identity through focus, minimize and document-state changes", async () => {
  const { runtime, install } = await setup();
  await install("1.0.0");
  let state = initialDesktop(runtime.snapshot());
  state = updateDesktop(
    state,
    runtime.prepare({ type: "new", id: "org.example.notes" }, state),
    runtime.snapshot(),
  );
  const id = state.open[0],
    lease = state.instances[id].extension;
  for (const action of [
    { type: "document-state" as const, id, dirty: true, busy: false },
    { type: "minimize" as const, id },
    { type: "focus" as const, id },
  ]) {
    state = updateDesktop(
      state,
      runtime.prepare(action, state),
      runtime.snapshot(),
    );
  }
  expect(state.instances[id].extension).toBe(lease);
  expect(state.instances[id].dirty).toBe(true);
  runtime.closeAll();
});
