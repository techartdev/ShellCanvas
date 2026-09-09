// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import {
  documentStateMethod,
  windowMethods,
  type WindowControls,
} from "./window-api";
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
it("rejects foreign targets and canceled requests before invoking window controls", () => {
  const focus = vi.fn();
  const controls: WindowControls = {
    focus,
    minimize: vi.fn(),
    maximize: vi.fn(),
    restore: vi.fn(),
    requestClose: vi.fn(),
    getState: () => ({
      visible: true,
      focused: true,
      mode: "normal",
      canMaximize: true,
    }),
  };
  const methods = windowMethods(() => controls);
  const signal = new AbortController().signal;
  for (const method of methods.values()) {
    expect(method.grants).toEqual([]);
    expect(() => method.invoke({ windowId: "another" }, signal)).toThrow(
      "no options",
    );
  }
  const canceled = new AbortController();
  canceled.abort();
  expect(() =>
    methods.get("system.window.focus")!.invoke(null, canceled.signal),
  ).toThrow("canceled");
  expect(focus).not.toHaveBeenCalled();
  expect(methods.get("system.window.focus")!.invoke(null, signal)).toBeNull();
  expect(focus).toHaveBeenCalledTimes(1);
  expect(
    methods.get("system.window.getState")!.invoke({}, signal),
  ).toMatchObject({ mode: "normal" });
});
it("advertises missing host controls as unavailable and uses the current owner callbacks", () => {
  let controls: WindowControls | undefined;
  const method = windowMethods(() => controls).get("system.window.minimize")!;
  expect(method.available!()).toBe(false);
  expect(() => method.invoke(null, new AbortController().signal)).toThrow(
    "unavailable",
  );
  const minimize = vi.fn();
  controls = { minimize } as unknown as WindowControls;
  expect(method.available!()).toBe(true);
  method.invoke(null, new AbortController().signal);
  expect(minimize).toHaveBeenCalledTimes(1);
  controls = undefined;
  expect(method.available!()).toBe(false);
});
