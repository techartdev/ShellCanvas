// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { watchFileLocations } from "./file-events";
import { bindSession } from "./session-services";
import { previewServices, previewSession } from "./preview";
import type { FileRelocation } from "./sdk";

it("coordinates open locations, blocks overlapping work and never applies failed or stale moves", async () => {
  let done!: (result: FileRelocation) => void;
  let fail!: (error: Error) => void;
  const moveEntry = vi.fn(
    () =>
      new Promise<FileRelocation>((resolve, reject) => {
        done = resolve;
        fail = reject;
      }),
  );
  const renameEntry = vi.fn(async () => ({ path: "other", locations: [] }));
  const session = {
    ...previewSession,
    id: 995,
    info: {
      ...previewSession.info,
      capabilities: ["files.move", "files.manage"] as const,
    },
  };
  const binding = bindSession(
    { ...previewServices, moveEntry, renameEntry },
    {
      ...session,
      info: { ...session.info, capabilities: [...session.info.capabilities] },
    },
  );
  let busy = false,
    path = "opaque@old";
  const pending = vi.fn();
  const relocated = vi.fn((maps: FileRelocation["locations"]) => {
    path = maps.find((m) => m.previous === path)?.location.path ?? path;
  });
  const stop = watchFileLocations(995, {
    snapshot: () => ({ paths: [path, path], busy }),
    pending,
    relocated,
  });
  const other = vi.fn();
  const stopOther = watchFileLocations(996, {
    snapshot: () => ({ paths: [path], busy: false }),
    pending: other,
    relocated: other,
  });
  const result = {
    path: "opaque@new",
    locations: [
      {
        previous: path,
        location: {
          path: "opaque@new",
          name: "A new name",
          parent: "folder@new",
        },
      },
    ],
  };
  try {
    busy = true;
    await expect(
      binding.services.moveEntry("source", "target", "rev"),
    ).rejects.toThrow("editor operations");
    expect(moveEntry).not.toHaveBeenCalled();
    busy = false;
    const moved = binding.services.moveEntry("source", "target", "rev");
    expect(moveEntry).toHaveBeenCalledWith(995, "source", "target", "rev", [
      "opaque@old",
    ]);
    expect(pending).toHaveBeenLastCalledWith(true);
    await expect(
      binding.services.renameEntry("another", "name", "rev"),
    ).rejects.toThrow("still running");
    expect(renameEntry).not.toHaveBeenCalled();
    done(result);
    await expect(moved).resolves.toBe("opaque@new");
    expect(path).toBe("opaque@new");
    expect(pending).toHaveBeenLastCalledWith(false);
    expect(other).not.toHaveBeenCalled();
    const failed = binding.services.moveEntry("source", "target", "rev");
    const rejection = expect(failed).rejects.toThrow("Permission denied");
    fail(new Error("Permission denied"));
    await rejection;
    expect(relocated).toHaveBeenCalledOnce();
    expect(pending).toHaveBeenLastCalledWith(false);
    const late = binding.services.moveEntry("source", "target", "rev");
    binding.dispose();
    done(result);
    await expect(late).rejects.toThrow("may have completed");
    expect(relocated).toHaveBeenCalledOnce();
    expect(pending).toHaveBeenLastCalledWith(false);
  } finally {
    stop();
    stopOther();
    binding.dispose();
  }
});

it("does not retarget editors opened or remounted after the operation started", async () => {
  const { beginFileRelocation } = await import("./file-events");
  const first = {
    snapshot: () => ({ paths: ["file"], busy: false }),
    pending: vi.fn(),
    relocated: vi.fn(),
  };
  const stop = watchFileLocations(997, first);
  const move = beginFileRelocation(997);
  stop();
  const later = { ...first, pending: vi.fn(), relocated: vi.fn() };
  const stopLater = watchFileLocations(997, later);
  move.apply({
    path: "new",
    locations: [
      {
        previous: "file",
        location: { path: "new", name: "new", parent: null },
      },
    ],
  });
  move.finish();
  expect(first.relocated).not.toHaveBeenCalled();
  expect(later.relocated).not.toHaveBeenCalled();
  expect(later.pending).not.toHaveBeenCalled();
  stopLater();
});
