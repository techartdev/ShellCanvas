// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import {
  activateFileEntry,
  type DirectoryActivation,
  fileLinkOpenError,
  formatFileModified,
  visibleFiles,
} from "./file-view";
import { defaultPreferences } from "./preferences";
import type { FileEntry } from "./sdk";
const entries: FileEntry[] = [
  { name: "file10", path: "/file10", kind: "file", size: 10, modified: 20 },
  { name: ".hidden", path: "/.hidden", kind: "file", size: 3, modified: null },
  { name: "folder", path: "/folder", kind: "directory", size: 0, modified: 30 },
  { name: "file2", path: "/file2", kind: "file", size: 5, modified: 10 },
];
it("filters and sorts naturally without changing provider data", () => {
  const before = structuredClone(entries);
  expect(
    visibleFiles(entries, "", {
      ...defaultPreferences,
      filesShowHidden: false,
    }).map((entry) => entry.name),
  ).toEqual(["folder", "file2", "file10"]);
  expect(
    visibleFiles(entries, "FILE", defaultPreferences).map(
      (entry) => entry.name,
    ),
  ).toEqual(["file2", "file10"]);
  expect(entries).toEqual(before);
});
it("keeps unknown dates last and independently controls folders and direction", () => {
  expect(
    visibleFiles(entries, "", {
      ...defaultPreferences,
      filesSort: "modified",
      filesDescending: true,
      filesFoldersFirst: false,
    }).map((entry) => entry.name),
  ).toEqual(["folder", "file10", "file2", ".hidden"]);
  expect(
    visibleFiles(entries, "", {
      ...defaultPreferences,
      filesSort: "size",
      filesDescending: true,
    }).map((entry) => entry.name),
  ).toEqual(["folder", "file10", "file2", ".hidden"]);
});

it("formats every known modified date with its year", () => {
  const localDate = new Date(2024, 8, 25, 12);
  expect(formatFileModified(localDate.getTime() / 1000, "en-US")).toBe(
    "Sep 25, 2024",
  );
  expect(formatFileModified(0, "en-US")).toBe("—");
  expect(formatFileModified(null, "en-US")).toBe("—");
});

it("opens folders directly and previews regular files without probing", async () => {
  const openDirectory = vi.fn(async () => ({ status: "opened" }) as const);
  const preview = vi.fn(async () => {});
  await activateFileEntry(entries[2], openDirectory, preview);
  expect(openDirectory).toHaveBeenCalledWith("/folder", { linkProbe: false });
  expect(preview).not.toHaveBeenCalled();

  await activateFileEntry(entries[0], openDirectory, preview);
  expect(preview).toHaveBeenCalledWith(entries[0], { linkFallback: false });
  expect(openDirectory).toHaveBeenCalledTimes(1);
});

it("opens directory links and falls back to file preview only after a failed probe", async () => {
  const link: FileEntry = {
    name: "public_html",
    path: "/home/site/public_html",
    kind: "symlink",
    size: 0,
    modified: null,
  };
  const openDirectory = vi.fn<() => Promise<DirectoryActivation>>(async () => ({
    status: "opened",
  }));
  const preview = vi.fn(async () => {});
  await activateFileEntry(link, openDirectory, preview);
  expect(openDirectory).toHaveBeenCalledWith(link.path, { linkProbe: true });
  expect(preview).not.toHaveBeenCalled();

  const directoryError = new Error("not a directory");
  openDirectory.mockResolvedValueOnce({
    status: "failed",
    error: directoryError,
  });
  await activateFileEntry(link, openDirectory, preview);
  expect(preview).toHaveBeenCalledWith(link, {
    linkFallback: true,
    directoryError,
  });
});

it("does not preview a link after canceled or partially accepted navigation", async () => {
  const link: FileEntry = {
    name: "alias",
    path: "/home/site/alias",
    kind: "symlink",
    size: 0,
    modified: null,
  };
  const preview = vi.fn(async () => {});
  for (const status of ["canceled", "opened"] as const) {
    await activateFileEntry(link, async () => ({ status }), preview);
  }
  expect(preview).not.toHaveBeenCalled();
});

it("reports both link activation failures without error stacks", () => {
  expect(
    fileLinkOpenError(
      new Error("permission denied"),
      new Error("not a regular text file"),
    ),
  ).toBe(
    "Cannot open link: folder access failed (permission denied); file preview failed (not a regular text file).",
  );
});
