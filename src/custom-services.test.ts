// SPDX-License-Identifier: MPL-2.0
import { it, expect, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import {
  createNativeCustomServices,
  nativeCustomServices,
} from "./custom-services";
it("captures custom discovery sources and refuses foreign workspaces before IPC", async () => {
  invoke.mockReset();
  invoke.mockResolvedValue([]);
  const source = { instance: 8, generation: 1, adapter: "fixture" };
  const services = createNativeCustomServices({
    sessionId: 4,
    sources: { acme: source },
  });
  source.instance = 9;
  await services.list(4);
  expect(invoke).toHaveBeenCalledWith("list_custom_services", {
    sessionId: 4,
    sources: { acme: { ...source, instance: 8 } },
  });
  invoke.mockClear();
  await expect(services.list(5)).rejects.toMatchObject({ code: "closed" });
  await expect(
    services.call(5, "binding", "acme.echo", null),
  ).rejects.toMatchObject({ code: "closed" });
  expect(invoke).not.toHaveBeenCalled();
});
it("allocates cancellation identity before dispatch and retains uncertain outcomes", async () => {
  invoke.mockReset();
  invoke.mockImplementation(async (name: string) => {
    if (name === "begin_custom_call") return "request-8";
    if (name === "call_custom_service")
      throw {
        code: "deadline",
        message: "Adapter deadline",
        outcomeUncertain: true,
      };
  });
  await expect(
    nativeCustomServices.call(4, "binding", "acme.echo", null),
  ).rejects.toMatchObject({
    code: "failed",
    message: expect.stringContaining("uncertain"),
  });
  expect(invoke).toHaveBeenCalledWith("cancel_custom_call", {
    requestId: "request-8",
  });
  const canceled = new AbortController();
  canceled.abort();
  invoke.mockClear();
  await expect(
    nativeCustomServices.call(4, "binding", "acme.echo", null, canceled.signal),
  ).rejects.toMatchObject({ code: "aborted" });
  expect(invoke).not.toHaveBeenCalled();
});
it("cleans up cancellation during allocation without dispatching and preserves busy errors", async () => {
  let allocated: (id: string) => void = () => {};
  invoke.mockReset();
  invoke.mockImplementation((name: string) =>
    name === "begin_custom_call"
      ? new Promise<string>((resolve) => {
          allocated = resolve;
        })
      : Promise.resolve(),
  );
  const controller = new AbortController();
  const pending = nativeCustomServices.call(
    1,
    "binding",
    "acme.echo",
    null,
    controller.signal,
  );
  controller.abort();
  allocated("canceled-request");
  await expect(pending).rejects.toMatchObject({ code: "aborted" });
  expect(invoke.mock.calls.map(([name]) => name)).toEqual([
    "begin_custom_call",
    "cancel_custom_call",
  ]);
  invoke.mockRejectedValueOnce({
    code: "busy",
    message: "Too many service calls",
    outcomeUncertain: false,
  });
  await expect(
    nativeCustomServices.call(1, "binding", "acme.echo", null),
  ).rejects.toMatchObject({ code: "busy" });
});
