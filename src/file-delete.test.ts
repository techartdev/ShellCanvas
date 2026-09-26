// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { deleteFiles, type DeleteResult } from "./file-delete";
import type { FileEntry } from "./sdk";
const entries: FileEntry[] = ["a", "b", "c"].map((name) => ({
  name,
  path: `opaque@${name}`,
  revision: `rev-${name}`,
  kind: "file",
  size: 1,
  modified: null,
}));
it("deletes sequentially using captured revisions and stops at the first uncertain failure", async () => {
  const reports: DeleteResult[] = [];
  const removeEntry = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("Lost acknowledgement"));
  await deleteFiles(
    { removeEntry },
    entries,
    () => true,
    (result) => reports.push(result),
  );
  expect(removeEntry.mock.calls).toEqual([
    ["opaque@a", "rev-a"],
    ["opaque@b", "rev-b"],
  ]);
  expect(reports.map((result) => result.status)).toEqual(["deleted", "failed"]);
  expect(reports[1].error).toContain("Lost acknowledgement");
});
it("stops after the in-flight item when cancellation or connection loss occurs", async () => {
  let allowed = true;
  let finish!: () => void;
  const reports: DeleteResult[] = [];
  const removeEntry = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const task = deleteFiles(
    { removeEntry },
    entries,
    () => allowed,
    (result) => reports.push(result),
  );
  allowed = false;
  finish();
  await task;
  expect(removeEntry).toHaveBeenCalledTimes(1);
  expect(reports[0].status).toBe("deleted");
});
it("validates the entire batch before deleting anything", async () => {
  const removeEntry = vi.fn();
  for (const invalid of [
    [],
    [entries[0], entries[0]],
    [entries[0], { ...entries[1], revision: undefined }],
    Array.from({ length: 101 }, (_, i) => ({ ...entries[0], path: String(i) })),
  ]) {
    await expect(
      deleteFiles(
        { removeEntry },
        invalid,
        () => true,
        () => {},
      ),
    ).rejects.toThrow();
  }
  await deleteFiles(
    { removeEntry },
    entries,
    () => false,
    () => {},
  );
  expect(removeEntry).not.toHaveBeenCalled();
});
it("deletes nested contents before folders without following links", async () => {
  const folder: FileEntry = {
    ...entries[0],
    kind: "directory",
    path: "opaque@folder",
  };
  const child: FileEntry = {
    ...entries[1],
    kind: "directory",
    path: "opaque@child",
  };
  const link: FileEntry = {
    ...entries[2],
    kind: "symlink",
    path: "opaque@link",
  };
  const file = { ...entries[0], path: "opaque@file" };
  const list = vi.fn(async (path: string) => ({
    path,
    entries:
      path === "opaque@parent"
        ? [folder]
        : path === folder.path
          ? [child, link]
          : [file],
  }));
  const removeEntry = vi.fn(async () => {});
  const reports: DeleteResult[] = [];
  await deleteFiles(
    { list, removeEntry },
    [folder],
    () => true,
    (result) => reports.push(result),
    { recursive: true, parent: "opaque@parent" },
  );
  expect(list.mock.calls.map(([path]) => path)).toEqual([
    "opaque@parent",
    "opaque@folder",
    "opaque@child",
  ]);
  expect(removeEntry.mock.calls).toEqual([
    [file.path, file.revision],
    [child.path, child.revision],
    [link.path, link.revision],
    [folder.path, folder.revision],
  ]);
  expect(reports.map((result) => result.status)).toEqual(["deleted"]);
});
it("does not descend into a selected folder that changed since confirmation", async () => {
  const folder: FileEntry = { ...entries[0], kind: "directory" };
  const list = vi.fn(async (path: string) => ({
    path,
    entries: [{ ...folder, revision: "changed" }],
  }));
  const removeEntry = vi.fn();
  await expect(
    deleteFiles(
      { list, removeEntry },
      [folder],
      () => true,
      () => {},
      {
        recursive: true,
        parent: "opaque@parent",
      },
    ),
  ).rejects.toThrow("changed");
  expect(removeEntry).not.toHaveBeenCalled();
});
it("reports partial folder deletion when stopped before the next item", async () => {
  const folder: FileEntry = { ...entries[0], kind: "directory" };
  let allowed = true;
  const list = vi.fn(async (path: string) => ({
    path,
    entries: path === "opaque@parent" ? [folder] : [entries[1], entries[2]],
  }));
  const removeEntry = vi.fn(async () => {
    allowed = false;
  });
  const reports: DeleteResult[] = [];
  await deleteFiles(
    { list, removeEntry },
    [folder],
    () => allowed,
    (result) => reports.push(result),
    { recursive: true, parent: "opaque@parent" },
  );
  expect(removeEntry).toHaveBeenCalledTimes(1);
  expect(reports.map((result) => result.status)).toEqual(["partial"]);
});
it("reports a partial folder when a child fails after another was removed", async () => {
  const folder: FileEntry = { ...entries[0], kind: "directory" };
  const list = vi.fn(async (path: string) => ({
    path,
    entries: path === "opaque@parent" ? [folder] : [entries[1], entries[2]],
  }));
  const removeEntry = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("Denied"));
  const reports: DeleteResult[] = [];
  await deleteFiles(
    { list, removeEntry },
    [folder],
    () => true,
    (result) => reports.push(result),
    { recursive: true, parent: "opaque@parent" },
  );
  expect(reports[0].status).toBe("partial");
  expect(reports[0].error).toContain("Denied");
});
