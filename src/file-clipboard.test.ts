// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { fileClipboard } from "./file-clipboard";
import { bindSession } from "./session-services";
import { previewServices, previewSession } from "./preview";
import type { FileEntry, FileRelocation } from "./sdk";

const source: FileEntry = {
  path: "object@93?kind=text",
  name: "Notes 🌍.txt",
  kind: "file",
  size: 10,
  modified: 1,
  revision: "original-revision",
};
const session = (id: number) => ({
  ...previewSession,
  id,
  info: {
    ...previewSession.info,
    capabilities: ["files.move" as const, "files.manage" as const],
  },
});
const moved: FileRelocation = {
  path: "moved@1",
  locations: [
    {
      previous: source.path,
      location: { path: "moved@1", name: source.name, parent: "folder@target" },
    },
  ],
};

it("shares one immutable cut across windows of a binding, preserves opaque paths and consumes it once", async () => {
  const moveEntry = vi.fn(async () => moved);
  const binding = bindSession({ ...previewServices, moveEntry }, session(1101));
  const first = fileClipboard(binding.services),
    second = fileClipboard(binding.services);
  const row = { ...source };
  first.cut(row, "folder@source");
  row.revision = "changed-after-cut";
  expect(second.snapshot().item?.entry.revision).toBe("original-revision");
  await expect(second.paste("folder@source")).rejects.toThrow(
    "different destination",
  );
  await expect(second.paste(source.path)).rejects.toThrow(
    "different destination",
  );
  expect(moveEntry).not.toHaveBeenCalled();
  await expect(second.paste("folder@target")).resolves.toBe("moved@1");
  expect(moveEntry).toHaveBeenCalledWith(
    1101,
    source.path,
    "folder@target",
    source.revision,
    [source.path, "folder@source"],
  );
  expect(first.snapshot().item).toBeNull();
  await expect(first.paste("another-target")).rejects.toThrow("Cut an item");
  expect(moveEntry).toHaveBeenCalledOnce();
  binding.dispose();
});

it("keeps a failed cut available for an explicit retry, with the original revision", async () => {
  const moveEntry = vi
    .fn()
    .mockRejectedValueOnce(new Error("Destination exists; nothing replaced"))
    .mockResolvedValue(moved);
  const binding = bindSession({ ...previewServices, moveEntry }, session(1102));
  const clipboard = fileClipboard(binding.services);
  clipboard.cut(source, "folder@source");
  await expect(clipboard.paste("collision@target")).rejects.toThrow(
    "Destination exists",
  );
  expect(clipboard.snapshot()).toMatchObject({
    working: false,
    item: { entry: source },
    error: expect.stringContaining("nothing replaced"),
  });
  expect(moveEntry).toHaveBeenCalledOnce(); // No automatic retry.
  await clipboard.paste("folder@target");
  expect(moveEntry.mock.calls[1].slice(1, 4)).toEqual([
    source.path,
    "folder@target",
    source.revision,
  ]);
  expect(clipboard.snapshot()).toEqual({
    item: null,
    working: false,
    error: "",
  });
  binding.dispose();
});

it("prevents double paste and replacing/canceling a cut during a move", async () => {
  let finish!: (value: FileRelocation) => void;
  const moveEntry = vi.fn(
    () =>
      new Promise<FileRelocation>((resolve) => {
        finish = resolve;
      }),
  );
  const binding = bindSession({ ...previewServices, moveEntry }, session(1103));
  const clipboard = fileClipboard(binding.services);
  clipboard.cut(source, "folder@source");
  const pending = clipboard.paste("folder@target");
  clipboard.cut({ ...source, path: "different" }, "other");
  clipboard.clear();
  expect(clipboard.snapshot().item?.entry.path).toBe(source.path);
  await expect(clipboard.paste("second-target")).rejects.toThrow(
    "already running",
  );
  finish(moved);
  await pending;
  expect(moveEntry).toHaveBeenCalledOnce();
  binding.dispose();
});

it("isolates hosts and clears on disconnect; a late outcome cannot clear a newly cut item", async () => {
  let finish!: (value: FileRelocation) => void;
  const moveEntry = vi.fn(
    () =>
      new Promise<FileRelocation>((resolve) => {
        finish = resolve;
      }),
  );
  const a = bindSession({ ...previewServices, moveEntry }, session(1104));
  const b = bindSession({ ...previewServices, moveEntry }, session(1105));
  const ca = fileClipboard(a.services),
    cb = fileClipboard(b.services);
  ca.cut(source, "folder@source");
  expect(cb.snapshot().item).toBeNull();
  await expect(cb.paste("folder@target")).rejects.toThrow("Cut an item");
  const pending = ca.paste("folder@target");
  a.dispose();
  expect(ca.snapshot().item).toBeNull();
  ca.cut(source, "folder@source");
  expect(ca.snapshot().item).toBeNull();
  a.activate();
  ca.cut({ ...source, path: "new-cut" }, "folder@source");
  finish(moved);
  await expect(pending).rejects.toThrow("may have completed");
  expect(ca.snapshot().item?.entry.path).toBe("new-cut");
  a.dispose();
  b.dispose();
});

it("invalidates cut locations after confirmed relocation, including a moved source parent", async () => {
  const renameEntry = vi.fn(
    async (_id, _path, _name, _rev, tracked: string[]) => ({
      path: "renamed-parent",
      locations: tracked
        .filter((path) => path === "folder@source")
        .map((previous) => ({
          previous,
          location: { path: "renamed-parent", name: "Renamed", parent: null },
        })),
    }),
  );
  const binding = bindSession(
    { ...previewServices, renameEntry },
    session(1106),
  );
  const clipboard = fileClipboard(binding.services);
  clipboard.cut(source, "folder@source");
  await binding.services.renameEntry("folder@source", "Renamed", "parent-rev");
  expect(clipboard.snapshot().item).toBeNull();
  clipboard.cut(source, "folder@other");
  await binding.services.renameEntry("unrelated", "New name", "rev");
  expect(clipboard.snapshot().item?.entry.path).toBe(source.path);
  clipboard.clear();
  expect(clipboard.snapshot().item).toBeNull();
  binding.dispose();
});

it("does not grant moves to a read-only session and refuses unversioned cuts", async () => {
  const moveEntry = vi.fn();
  const binding = bindSession(
    { ...previewServices, moveEntry },
    {
      ...session(1107),
      info: { ...previewSession.info, capabilities: ["files.read"] },
    },
  );
  const clipboard = fileClipboard(binding.services);
  expect(() =>
    clipboard.cut({ ...source, revision: undefined }, "folder"),
  ).toThrow("Refresh");
  clipboard.cut(source, "folder@source");
  await expect(clipboard.paste("target")).rejects.toThrow("files.move");
  expect(moveEntry).not.toHaveBeenCalled();
  binding.dispose();
});

it("clears a cut after confirmed deletion, but retains it after failed deletion", async () => {
  const removeEntry = vi
    .fn()
    .mockRejectedValueOnce(new Error("Permission denied"))
    .mockResolvedValue(undefined);
  const binding = bindSession(
    { ...previewServices, removeEntry },
    session(1108),
  );
  const clipboard = fileClipboard(binding.services);
  clipboard.cut(source, "folder@source");
  await expect(
    binding.services.removeEntry(source.path, source.revision!),
  ).rejects.toThrow("Permission denied");
  expect(clipboard.snapshot().item?.entry.path).toBe(source.path);
  await binding.services.removeEntry(source.path, source.revision!);
  expect(clipboard.snapshot().item).toBeNull();
  binding.dispose();
});
