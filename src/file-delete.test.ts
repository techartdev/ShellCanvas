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
