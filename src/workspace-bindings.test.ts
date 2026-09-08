// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { WorkspaceBindings } from "./workspace-bindings";
import { previewServices, previewSession } from "./preview";
import { fileClipboard } from "./file-clipboard";
import {
  capabilityLabels,
  type Capability,
  type DesktopApp,
  type Session,
} from "./sdk";

const app = (
  id: string,
  requires: Capability[],
  customPermissions: string[] = [],
): DesktopApp => ({
  id,
  apiVersion: 1,
  title: id,
  subtitle: "test",
  scope: "host",
  requires,
  customPermissions,
  component: () => null,
  icon: () => null,
});
const apps = new Map([
  ["files", app("files", ["files.read", "files.move"])],
  ["terminal", app("terminal", ["terminal"])],
  ["custom", app("custom", [], ["services.acme"])],
]);
function session(files = 1, terminal = 2, custom = 3): Session {
  return {
    ...previewSession,
    id: 7001,
    services: (Object.keys(capabilityLabels) as Capability[]).map(
      (capability) => ({
        capability,
        state: "available",
        source: {
          instance: capability === "terminal" ? terminal : files,
          generation: 1,
          adapter: "fixture",
        },
      }),
    ),
    customSources: {
      acme: { instance: custom, generation: 1, adapter: "fixture" },
    },
  };
}
const entry = {
  path: "opaque@file",
  name: "file",
  kind: "file" as const,
  size: 1,
  modified: 1,
  revision: "v1",
};
it("rebinds only affected apps and preserves clipboard sharing with newly opened windows", () => {
  const pool = new WorkspaceBindings(previewServices, () => {});
  const first = pool.prepare(session(), apps);
  pool.commit(first, true);
  const files = first.windows.get("files")!.record.binding.services;
  const terminal = first.windows.get("terminal")!.record.binding.services;
  const custom = first.windows.get("custom")!.record.binding.services;
  const clipboard = fileClipboard(files);
  clipboard.copy([entry], "opaque@parent");
  const consoleChanged = pool.prepare(session(1, 20), apps);
  pool.commit(consoleChanged, true);
  expect(consoleChanged.windows.get("files")!.record.binding.services).toBe(
    files,
  );
  expect(
    consoleChanged.windows.get("terminal")!.record.binding.services,
  ).not.toBe(terminal);
  expect(consoleChanged.windows.get("custom")!.record.binding.services).toBe(
    custom,
  );
  const withNewWindow = new Map(apps);
  withNewWindow.set("files2", apps.get("files")!);
  const opened = pool.prepare(session(1, 20), withNewWindow);
  pool.commit(opened, true);
  const newerFiles = opened.windows.get("files2")!.record.binding.services;
  expect(fileClipboard(newerFiles)).toBe(clipboard);
  expect(clipboard.snapshot().copies).toHaveLength(1);
  withNewWindow.delete("files");
  const closed = pool.prepare(session(1, 20), withNewWindow);
  pool.commit(closed, true);
  expect(clipboard.snapshot().copies).toHaveLength(1);
  const replaced = pool.prepare(session(10, 20), withNewWindow);
  pool.commit(replaced, true);
  expect(replaced.windows.get("terminal")!.record).toBe(
    opened.windows.get("terminal")!.record,
  );
  expect(
    fileClipboard(replaced.windows.get("files2")!.record.binding.services),
  ).not.toBe(clipboard);
  expect(clipboard.snapshot().copies).toBeUndefined();
  const customChanged = pool.prepare(session(10, 20, 30), withNewWindow);
  pool.commit(customChanged, true);
  expect(customChanged.windows.get("files2")!.record).toBe(
    replaced.windows.get("files2")!.record,
  );
  expect(customChanged.windows.get("custom")!.record).not.toBe(
    replaced.windows.get("custom")!.record,
  );
  pool.dispose();
});

it("polling and abandoned plans do not retire live handles; disposal rejects late work", async () => {
  let finish!: (value: string) => void;
  const preview = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const pool = new WorkspaceBindings({ ...previewServices, preview }, () => {});
  const first = pool.prepare(session(), apps);
  pool.commit(first, true);
  const files = first.windows.get("files")!.record.binding.services;
  const pending = files.preview("opaque@file");
  pool.prepare(session(99), apps); // Aborted React render: no lifecycle effects.
  const polled = pool.prepare(session(), apps);
  pool.commit(polled, true);
  expect(polled.windows.get("files")!.record.binding.services).toBe(files);
  finish("same source");
  await expect(pending).resolves.toBe("same source");
  const late = files.preview("opaque@file");
  const replaced = pool.prepare(session(10), apps);
  pool.commit(replaced, true);
  finish("old source");
  await expect(late).rejects.toThrow();
  pool.dispose();
  await expect(
    replaced.windows.get("files")!.record.binding.services.list(),
  ).rejects.toThrow();
  // React StrictMode remount of the committed plan gets a fresh usable lifetime.
  pool.commit(replaced, true);
  await expect(
    replaced.windows.get("files")!.record.binding.services.list(),
  ).resolves.toBeDefined();
  pool.dispose();
});
