// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it, vi } from "vitest";
import {
  UpdateController,
  updateBlocker,
  type UpdateService,
} from "./app-update";

const release = { version: "0.2.0", currentVersion: "0.1.4", notes: "Fixes" };
function fixture() {
  const service: UpdateService = {
    check: vi.fn(async () => release),
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
  return { service, controller: new UpdateController(service) };
}
describe("desktop updates", () => {
  it("detects without downloading or installing automatically", async () => {
    const { controller, service } = fixture();
    await controller.check();
    expect(controller.snapshot().stage).toBe("available");
    expect(service.download).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
  });
  it("blocks before download and checks again before installation", async () => {
    const { controller, service } = fixture();
    await controller.check();
    await controller.apply(() => updateBlocker(true, false));
    expect(service.download).not.toHaveBeenCalled();
    const blocker = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce("New unsaved work");
    await controller.apply(blocker);
    expect(service.download).toHaveBeenCalledOnce();
    expect(service.install).not.toHaveBeenCalled();
    expect(controller.snapshot().error).toContain("New unsaved work");
  });
  it("never installs after download/signature failure and allows retry", async () => {
    const { controller, service } = fixture();
    vi.mocked(service.download).mockRejectedValueOnce(
      new Error("Bad signature"),
    );
    await controller.check();
    await controller.apply(() => undefined);
    expect(service.install).not.toHaveBeenCalled();
    expect(controller.snapshot().error).toContain("Bad signature");
    await controller.apply(() => undefined);
    expect(service.install).toHaveBeenCalledWith("0.2.0");
  });
  it.each([false, true])(
    "cancellation invalidates late completion and progress (cancel fails: %s)",
    async (fails) => {
      const { controller, service } = fixture();
      if (fails)
        vi.mocked(service.cancel).mockRejectedValueOnce("IPC unavailable");
      let finish!: () => void;
      let progress!: Parameters<UpdateService["download"]>[1];
      service.download = vi.fn((_, callback) => {
        progress = callback;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
      await controller.check();
      const applying = controller.apply(() => undefined);
      await controller.cancel();
      progress({ downloaded: 100, total: 100 });
      finish();
      await applying;
      expect(service.install).not.toHaveBeenCalled();
      expect(controller.snapshot().stage).toBe("available");
      expect(controller.snapshot().progress).toBeUndefined();
      if (fails)
        expect(controller.snapshot().error).toContain("will not be installed");
    },
  );
  it("rejects duplicate apply/check while downloading and keeps failures recoverable", async () => {
    const { controller, service } = fixture();
    let finish!: () => void;
    service.download = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    vi.mocked(service.install).mockRejectedValueOnce("Detach drives first");
    await controller.check();
    const applying = controller.apply(() => undefined);
    await controller.apply(() => undefined);
    await controller.check();
    expect(service.check).toHaveBeenCalledOnce();
    expect(service.download).toHaveBeenCalledOnce();
    finish();
    await applying;
    expect(controller.snapshot()).toMatchObject({
      stage: "available",
      error: "Detach drives first",
    });
  });
  it("handles no-update, offline and busy states", async () => {
    const { controller, service } = fixture();
    vi.mocked(service.check)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce("Offline");
    await controller.check();
    expect(controller.snapshot().stage).toBe("current");
    await controller.check();
    expect(controller.snapshot().error).toBe("Offline");
    expect(updateBlocker(false, true)).toContain("running app tasks");
  });
});
