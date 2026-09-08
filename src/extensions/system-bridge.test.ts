// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { SystemError, type SystemAPI } from "../system-api";
import { systemMethods } from "./system-bridge";
import type { Json } from "./rpc";
function setup() {
  const api: SystemAPI = {
    apiVersion: 1,
    dialogs: {
      messageBox: vi.fn(async () => "ok"),
      openFile: vi.fn(async () => []),
      saveFile: vi.fn(async () => null),
    },
    files: { saveTextAs: vi.fn(async () => null) },
  };
  return {
    api,
    methods: systemMethods(api),
    signal: new AbortController().signal,
  };
}
it("exposes explicit methods and supplies only the host-owned window system handle", async () => {
  const { api, methods, signal } = setup();
  const message = methods.get("system.dialogs.messageBox")!;
  expect(message.grants).toEqual(["system.dialogs"]);
  await expect(
    message.invoke({ title: "Example", message: "Hello" }, signal),
  ).resolves.toBe("ok");
  expect(api.dialogs.messageBox).toHaveBeenCalledWith(
    { title: "Example", message: "Hello" },
    { signal },
  );
  expect(methods.get("system.dialogs.openFile")!.grants).toEqual([
    "system.dialogs",
    "files.read",
  ]);
  expect(methods.has("system.private.credentials")).toBe(false);
  await expect(
    message.invoke(
      { title: "Example", message: "Hello", sessionId: 99 },
      signal,
    ),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(api.dialogs.messageBox).toHaveBeenCalledTimes(1);
});
it("rejects malformed nested options before reaching trusted system UI", async () => {
  const { api, methods, signal } = setup();
  const message = methods.get("system.dialogs.messageBox")!;
  const malformed: Json[] = [
    null,
    [],
    { title: "Example" },
    { title: "Example", message: "Hello", buttons: "bad" },
    {
      title: "Example",
      message: "Hello",
      buttons: [{ id: "ok", label: "OK", destructive: "false" }],
    },
  ];
  for (const params of malformed) {
    await expect(message.invoke(params, signal)).rejects.toMatchObject({
      code: "invalid",
    });
  }
  await expect(
    methods
      .get("system.dialogs.openFile")!
      .invoke({ multiple: "true" }, signal),
  ).rejects.toMatchObject({ code: "invalid" });
  await expect(
    methods
      .get("system.dialogs.openFile")!
      .invoke({ extensions: [false] }, signal),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(api.dialogs.messageBox).not.toHaveBeenCalled();
  expect(api.dialogs.openFile).not.toHaveBeenCalled();
});
it("preserves structured system cancellation errors and passes the caller's lifetime signal", async () => {
  const { api, methods } = setup();
  const controller = new AbortController();
  api.dialogs.openFile = vi.fn(async (_, control) => {
    expect(control?.signal).toBe(controller.signal);
    throw new SystemError("aborted", "Dialog canceled.");
  });
  await expect(
    methods.get("system.dialogs.openFile")!.invoke({}, controller.signal),
  ).rejects.toMatchObject({ code: "aborted", message: "Dialog canceled." });
});

it("never grants replacement implicitly through the compound Save As operation", async () => {
  const { api, signal } = setup();
  const params = { text: "New content", allowReplace: true };
  await systemMethods(api)
    .get("system.files.saveTextAs")!
    .invoke(params, signal);
  expect(api.files.saveTextAs).toHaveBeenLastCalledWith(
    { text: "New content", allowReplace: false },
    { signal },
  );
  const grants = ["files.edit"];
  const methods = systemMethods(api, grants);
  grants.length = 0; // Approval was snapshotted for this instance.
  await methods.get("system.files.saveTextAs")!.invoke(params, signal);
  expect(api.files.saveTextAs).toHaveBeenLastCalledWith(
    { text: "New content", allowReplace: true },
    { signal },
  );
  await methods
    .get("system.files.saveTextAs")!
    .invoke({ text: "New content", allowReplace: false }, signal);
  expect(api.files.saveTextAs).toHaveBeenLastCalledWith(
    { text: "New content", allowReplace: false },
    { signal },
  );
});
