// SPDX-License-Identifier: MPL-2.0
import { expect, it } from "vitest";
import {
  editBuffer,
  lineEnding,
  normaliseText,
  serialiseText,
} from "./editor-state";
it("preserves CRLF and Unicode through editing and save serialization", () => {
  const original = "Hello 🌍\r\nSecond line\r\n";
  expect(serialiseText(normaliseText(original), lineEnding(original))).toBe(
    original,
  );
  expect(lineEnding("one\ntwo\n")).toBe("LF");
});
it("supports undo, redo, branching edits, and a clean load history", () => {
  let state = editBuffer(
    { text: "", past: [], future: [] },
    { type: "load", text: "original" },
  );
  state = editBuffer(state, { type: "change", text: "draft" });
  state = editBuffer(state, { type: "undo" });
  expect(state.text).toBe("original");
  state = editBuffer(state, { type: "redo" });
  expect(state.text).toBe("draft");
  state = editBuffer(state, { type: "undo" });
  state = editBuffer(state, { type: "change", text: "different" });
  expect(state.future).toEqual([]);
  state = editBuffer(state, { type: "load", text: "remote" });
  expect(state.past).toEqual([]);
});
