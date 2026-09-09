// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import {
  installMediaQueryListeners,
  installRandomUUID,
} from "./platform-compat";

it("preserves native UUID generation and uses secure bytes with v4/variant bits for old engines", () => {
  const native = vi.fn(() => "native");
  const modern = { randomUUID: native } as unknown as Crypto;
  installRandomUUID(modern);
  expect(modern.randomUUID).toBe(native);

  const random = vi.fn((bytes: Uint8Array) => {
    bytes.fill(255);
    return bytes;
  });
  const legacy = { getRandomValues: random } as unknown as Crypto;
  installRandomUUID(legacy);
  expect(legacy.randomUUID()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  expect(random).toHaveBeenCalledOnce();
  const installed = legacy.randomUUID;
  installRandomUUID(legacy);
  expect(legacy.randomUUID).toBe(installed);
});

it("never substitutes weak randomness when the platform secure generator fails", () => {
  const legacy = {
    getRandomValues: () => {
      throw new Error("secure generator unavailable");
    },
  } as unknown as Crypto;
  installRandomUUID(legacy);
  expect(() => legacy.randomUUID()).toThrow("secure generator unavailable");
});

it("bridges xterm change subscriptions and removes the original callback on disposal", () => {
  const listeners = new Set<unknown>();
  const prototype = {
    addListener: (listener: unknown) => listeners.add(listener),
    removeListener: (listener: unknown) => listeners.delete(listener),
  } as unknown as MediaQueryList;
  installMediaQueryListeners(prototype);
  const media = Object.create(prototype) as MediaQueryList;
  const listener = vi.fn();
  media.addEventListener("change", listener);
  expect(listeners.has(listener)).toBe(true);
  media.removeEventListener("change", listener);
  expect(listeners.size).toBe(0);
  const modern = { addEventListener: vi.fn() } as unknown as MediaQueryList;
  const original = modern.addEventListener;
  installMediaQueryListeners(modern);
  expect(modern.addEventListener).toBe(original);
});
