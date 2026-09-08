// SPDX-License-Identifier: MPL-2.0
import { expect, it } from "vitest";
import { selectFiles } from "./file-selection";
it("toggles opaque identities and selects ranges in displayed order", () => {
  const order = ["z@folder", "file?2", "file?10", "a@last"];
  expect(selectFiles([], order, order[1], null)).toEqual([order[1]]);
  expect(selectFiles([order[1]], order, order[3], order[1], true)).toEqual([
    order[1],
    order[3],
  ]);
  expect(
    selectFiles([order[1], order[3]], order, order[1], order[3], true),
  ).toEqual([order[3]]);
  expect(selectFiles([], order, order[0], order[2], false, true)).toEqual(
    order.slice(0, 3),
  );
  expect(
    selectFiles([order[0]], order, order[3], order[2], true, true),
  ).toEqual([order[0], order[2], order[3]]);
});
it("drops invisible selections and handles missing anchors without guessing a range", () => {
  expect(
    selectFiles(["hidden", "b"], ["b", "a"], "a", "hidden", false, true),
  ).toEqual(["a"]);
  expect(selectFiles(["hidden", "b"], ["b", "a"], "absent", null)).toEqual([
    "b",
  ]);
});
