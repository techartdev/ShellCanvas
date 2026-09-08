// SPDX-License-Identifier: MPL-2.0
import { expect, it } from "vitest";
import {
  relocateNavigation,
  trackedNavigation,
  type FileNavigation,
} from "./file-navigation";
const view: FileNavigation = {
  directory: {
    path: "folder@old",
    name: "Old",
    parent: "parent@old",
    home: { path: "folder@old", name: "Home" },
    roots: [{ path: "volume@main", name: "Main" }],
    entries: [
      {
        path: "item@1",
        name: "before.txt",
        kind: "file",
        size: 12,
        modified: null,
      },
    ],
  },
  history: ["history@unrelated", "parent@old", "folder@old"],
  pathInput: "folder@old",
  selected: "item@1",
  document: { path: "item@1", name: "before.txt", text: "Preview text" },
};
const mappings = [
  {
    previous: "folder@old",
    location: { path: "new#20", name: "New folder", parent: "new#parent" },
  },
  {
    previous: "parent@old",
    location: { path: "new#parent", name: "New parent", parent: "volume@main" },
  },
  {
    previous: "item@1",
    location: { path: "changed?item", name: "after.txt", parent: "new#20" },
  },
];
it("tracks visible identities and maps current folder, history, places, selection and preview using only provider results", () => {
  expect(trackedNavigation(view)).toEqual([
    "folder@old",
    "parent@old",
    "volume@main",
    "history@unrelated",
    "item@1",
  ]);
  const next = relocateNavigation(view, mappings);
  expect(next.directory).toMatchObject({
    path: "new#20",
    name: "New folder",
    parent: "new#parent",
    entries: [],
    home: { path: "new#20", name: "Home" },
  });
  expect(next.history).toEqual(["history@unrelated", "new#parent", "new#20"]);
  expect(next.pathInput).toBe("new#20");
  expect(next.selected).toBe("changed?item");
  expect(next.document).toMatchObject({
    path: "changed?item",
    name: "after.txt",
    text: "Preview text",
  });
  expect(view.directory.path).toBe("folder@old");
});
it("preserves typed addresses and ignores prefix-like paths without a mapping", () => {
  const next = relocateNavigation(
    {
      ...view,
      pathInput: "typed address",
      history: ["folder@old/looks-like-child", "folder@older"],
    },
    mappings,
  );
  expect(next.pathInput).toBe("typed address");
  expect(next.history).toEqual(["folder@old/looks-like-child", "folder@older"]);
  const untouched = relocateNavigation(view, []);
  expect(untouched).toEqual(view);
  expect(
    relocateNavigation({ ...view, document: null, selected: null }, mappings)
      .document,
  ).toBeNull();
});
