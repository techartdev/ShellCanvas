// SPDX-License-Identifier: MPL-2.0
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  startAutomaticUpdateChecks,
  UpdateController,
  UPDATE_CHECK_INTERVAL,
  UPDATE_RETRY_INTERVAL,
  type UpdateService,
} from "./app-update";

let browser: EventTarget;
let page: EventTarget & { visibilityState: string };
let connection: { onLine: boolean };
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
  browser = Object.assign(new EventTarget(), { setInterval, clearInterval });
  page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  connection = { onLine: true };
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", page);
  vi.stubGlobal("navigator", connection);
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function fixture() {
  const service: UpdateService = {
    check: vi.fn(async () => null),
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
  const controller = new UpdateController(service);
  return { service, controller };
}

it("checks at launch and repeatedly while open without installing", async () => {
  const { service, controller } = fixture();
  stop = startAutomaticUpdateChecks(controller);
  expect(service.check).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL - 1);
  expect(service.check).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(service.check).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL);
  expect(service.check).toHaveBeenCalledTimes(3);
  expect(service.download).not.toHaveBeenCalled();
  expect(service.install).not.toHaveBeenCalled();
});

it("still checks when the system reports offline, then retries on recovery", async () => {
  const { service, controller } = fixture();
  vi.mocked(service.check).mockRejectedValueOnce("Network unavailable");
  connection.onLine = false;
  stop = startAutomaticUpdateChecks(controller);
  expect(service.check).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  connection.onLine = true;
  browser.dispatchEvent(new Event("online"));
  expect(service.check).toHaveBeenCalledTimes(2);
});

it("retries failed checks after five minutes", async () => {
  const { service, controller } = fixture();
  vi.mocked(service.check).mockRejectedValueOnce("Network unavailable");
  stop = startAutomaticUpdateChecks(controller);
  await vi.advanceTimersByTimeAsync(UPDATE_RETRY_INTERVAL - 1);
  expect(service.check).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(service.check).toHaveBeenCalledTimes(2);
  expect(controller.snapshot().stage).toBe("current");
});

it("retries on network recovery without repeated focus checks", async () => {
  const { service, controller } = fixture();
  vi.mocked(service.check).mockRejectedValueOnce("Offline");
  stop = startAutomaticUpdateChecks(controller);
  await vi.advanceTimersByTimeAsync(60_000);
  browser.dispatchEvent(new Event("online"));
  browser.dispatchEvent(new Event("focus"));
  browser.dispatchEvent(new Event("online"));
  expect(service.check).toHaveBeenCalledTimes(2);
});

it("checks after sleep on focus or visibility and counts manual checks", async () => {
  const { service, controller } = fixture();
  stop = startAutomaticUpdateChecks(controller);
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  await controller.check();
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  expect(service.check).toHaveBeenCalledTimes(2);
  vi.setSystemTime(Date.now() + UPDATE_CHECK_INTERVAL);
  page.dispatchEvent(new Event("visibilitychange"));
  browser.dispatchEvent(new Event("focus"));
  expect(service.check).toHaveBeenCalledTimes(3);
});

it("does not check during a download and removes timers and listeners on cleanup", async () => {
  const { service, controller } = fixture();
  vi.mocked(service.check).mockResolvedValue({
    version: "0.2.0",
    currentVersion: "0.1.13",
    notes: "",
  });
  let finish!: () => void;
  service.download = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  stop = startAutomaticUpdateChecks(controller);
  await vi.advanceTimersByTimeAsync(0);
  const applying = controller.apply(() => undefined);
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL);
  expect(service.check).toHaveBeenCalledOnce();
  stop();
  finish();
  await applying;
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL);
  browser.dispatchEvent(new Event("focus"));
  browser.dispatchEvent(new Event("online"));
  page.dispatchEvent(new Event("visibilitychange"));
  expect(service.check).toHaveBeenCalledOnce();
});
