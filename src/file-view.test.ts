// SPDX-License-Identifier: MPL-2.0
import { expect, it } from "vitest";
import { visibleFiles } from "./file-view";
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
