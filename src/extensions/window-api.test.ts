// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { documentStateMethod } from "./window-api";
it("allows an app to update only its own document state", () => {
  const update = vi.fn();
  const method = documentStateMethod(update);
  const signal = new AbortController().signal;
  expect(
    method.invoke({ dirty: true, busy: false, title: "Draft" }, signal),
  ).toBeNull();
  expect(update).toHaveBeenCalledWith({
    dirty: true,
    busy: false,
    title: "Draft",
  });
  expect(() =>
    method.invoke({ dirty: true, busy: false, windowId: "foreign" }, signal),
  ).toThrow("Provide dirty");
  expect(() => method.invoke({ dirty: "false", busy: false }, signal)).toThrow(
    "Provide dirty",
  );
  expect(update).toHaveBeenCalledTimes(1);
});
