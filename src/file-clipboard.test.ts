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
    capabilities: [
      "files.move" as const,
      "files.manage" as const,
      "files.copy" as const,
    ],
  },
});
it("prepares large immutable selections as one native job and releases a stale batch", async () => {
  const prepareCopySelection = vi.fn(
    async (
      _sessionId: number,
      _entries: { path: string; revision: string }[],
      _parent: string,
    ) => ({
      id: 42,
      name: "1000 copied items",
      size: 10000,
      direction: "copy" as const,
    }),
  );
  const cancelTransfer = vi.fn(async () => {});
  const prepareCopy = vi.fn();
  const binding = bindSession(
    { ...previewServices, prepareCopySelection, prepareCopy, cancelTransfer },
    session(1120),
  );
  const clipboard = fileClipboard(binding.services);
  const entries = Array.from({ length: 1000 }, (_, index) => ({
    ...source,
    path: `entry@${index}`,
  }));
  clipboard.copy(entries, "source");
  entries[0].revision = "changed-after-copy";
  try {
    expect(
      await clipboard.prepareCopies("target", binding.services),
    ).toHaveLength(1);
    expect(prepareCopySelection).toHaveBeenCalledWith(
      1120,
      expect.arrayContaining([{ path: "entry@0", revision: source.revision }]),
      "target",
    );
    expect(prepareCopySelection.mock.calls[0][1]).toHaveLength(1000);
    expect(prepareCopy).not.toHaveBeenCalled();
    const pending = clipboard.prepareCopies("another-target", binding.services);
    clipboard.removed("entry@0");
    await expect(pending).rejects.toThrow("changed");
    expect(cancelTransfer).toHaveBeenCalledWith(1120, 42);
    expect(clipboard.snapshot().working).toBe(false);
  } finally {
    binding.dispose();
  }
});
it("copies several immutable sources, queues through the receiving app, and permits another destination", async () => {
  let id = 10;
  const prepareCopy = vi.fn(async () => ({
    id: ++id,
    name: "copy",
    size: 10,
    direction: "copy" as const,
  }));
  const binding = bindSession(
    { ...previewServices, prepareCopy },
    session(1110),
  );
  const clipboard = fileClipboard(binding.services);
  const other = { ...source, path: "other@file" };
  clipboard.copy([source, other], "folder@source");
  other.revision = "changed";
  await expect(
    clipboard.prepareCopies("folder@source", binding.services),
  ).rejects.toThrow("different destination");
  expect(
    await clipboard.prepareCopies("folder@target", binding.services),
  ).toHaveLength(2);
  expect(prepareCopy.mock.calls[1]).toEqual([
    1110,
    "other@file",
    source.revision,
    "folder@target",
  ]);
  expect(clipboard.snapshot().copies).toHaveLength(2);
  expect(
    await clipboard.prepareCopies("another@target", binding.services),
  ).toHaveLength(2);
  binding.dispose();
});
it("releases all prepared copies if a later preparation fails, without running any transfer", async () => {
  const cancelTransfer = vi.fn(async () => {});
  const runTransfer = vi.fn();
  const prepareCopy = vi
    .fn()
    .mockResolvedValueOnce({ id: 10, name: "one", size: 1, direction: "copy" })
    .mockRejectedValueOnce(new Error("Queue full"));
  const binding = bindSession(
    { ...previewServices, prepareCopy, cancelTransfer, runTransfer },
    session(1111),
  );
  const clipboard = fileClipboard(binding.services);
  clipboard.copy([source, { ...source, path: "two" }], "source");
  await expect(
    clipboard.prepareCopies("destination", binding.services),
  ).rejects.toThrow("Queue full");
  expect(cancelTransfer).toHaveBeenCalledWith(1111, 10);
  expect(runTransfer).not.toHaveBeenCalled();
  expect(clipboard.snapshot().working).toBe(false);
  expect(clipboard.snapshot().copies).toHaveLength(2);
  binding.dispose();
});
it("invalidates copied batches when a source is removed or relocated", () => {
  const binding = bindSession(previewServices, session(1112));
  const clipboard = fileClipboard(binding.services);
  clipboard.copy([source], "source");
  clipboard.removed(source.path);
  expect(clipboard.snapshot().copies).toBeUndefined();
  clipboard.copy([source], "source");
  clipboard.relocated({
    path: "target",
    locations: [
      {
        previous: "source",
        location: { path: "target", name: "Target", parent: null },
      },
    ],
  });
  expect(clipboard.snapshot().copies).toBeUndefined();
  expect(() =>
    clipboard.copy([{ ...source, kind: "symlink" }], "source"),
  ).toThrow("files or folders");
  clipboard.copy([{ ...source, kind: "directory" }], "source");
  expect(clipboard.snapshot().copies?.[0].entry.kind).toBe("directory");
  binding.dispose();
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

it("does not let a late canceled preparation unlock work on a reactivated clipboard", async () => {
  const binding = bindSession(previewServices, session(1113));
  const clipboard = fileClipboard(binding.services);
  let finishOld!: (ticket: any) => void;
  let finishNew!: (ticket: any) => void;
  const services = {
    ...binding.services,
    prepareCopy: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishNew = resolve;
          }),
      ),
    cancelTransfer: vi.fn(async () => {}),
  };
  clipboard.copy([source], "source");
  const old = clipboard.prepareCopies("destination", services);
  clipboard.dispose();
  clipboard.activate();
  clipboard.copy([{ ...source, path: "new-source" }], "source");
  const newer = clipboard.prepareCopies("destination", services);
  finishOld({ id: 1, name: "old", size: 10, direction: "copy" });
  await expect(old).rejects.toThrow("changed");
  expect(clipboard.snapshot().working).toBe(true);
  expect(clipboard.snapshot().copies?.[0].entry.path).toBe("new-source");
  finishNew({ id: 2, name: "new", size: 10, direction: "copy" });
  await expect(newer).resolves.toHaveLength(1);
  expect(clipboard.snapshot().working).toBe(false);
  expect(services.cancelTransfer).toHaveBeenCalledExactlyOnceWith(1);
  binding.dispose();
});

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
