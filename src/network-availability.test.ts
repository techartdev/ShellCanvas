// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, it, vi } from "vitest";
import {
  networkAvailable,
  subscribeNetworkAvailability,
} from "./network-availability";

afterEach(() => vi.unstubAllGlobals());

it("reports network transitions and unsubscribes cleanly", () => {
  const browser = new EventTarget();
  const connection = { onLine: true };
  vi.stubGlobal("window", browser);
  vi.stubGlobal("navigator", connection);
  const observed: boolean[] = [];
  const stop = subscribeNetworkAvailability(() =>
    observed.push(networkAvailable()),
  );
  expect(networkAvailable()).toBe(true);
  connection.onLine = false;
  browser.dispatchEvent(new Event("offline"));
  connection.onLine = true;
  browser.dispatchEvent(new Event("online"));
  expect(observed).toEqual([false, true]);
  stop();
  browser.dispatchEvent(new Event("offline"));
  expect(observed).toHaveLength(2);
});
