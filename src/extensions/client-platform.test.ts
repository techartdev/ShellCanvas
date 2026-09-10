// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi, afterEach } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { readClientEnvironment } from "./client-platform";
import { clientCompatibilityReason } from "../../packages/app-sdk/src/client-platform";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
afterEach(() => vi.resetAllMocks());
it("uses the native compile target, never browser or remote-host labels", async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  for (const platform of ["windows", "macos", "linux", "android", "ios"]) {
    vi.mocked(invoke).mockResolvedValue(platform);
    expect(await readClientEnvironment()).toEqual({ platform });
  }
  expect(invoke).toHaveBeenCalledWith("client_platform");
  vi.mocked(invoke).mockResolvedValue("future-os");
  const unknown = await readClientEnvironment();
  expect(unknown.platform).toBe("unknown");
  expect(
    clientCompatibilityReason({ clientPlatforms: ["linux"] }, unknown),
  ).toContain("Not available");
  vi.mocked(invoke).mockRejectedValue(new Error("IPC unavailable"));
  await expect(readClientEnvironment()).rejects.toThrow("IPC unavailable");
});
it("treats browser previews as web clients and preserves unrestricted legacy packages", async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  const client = await readClientEnvironment();
  expect(client.platform).toBe("web");
  expect(invoke).not.toHaveBeenCalled();
  expect(clientCompatibilityReason({}, client)).toBeUndefined();
  expect(
    clientCompatibilityReason({ clientPlatforms: ["android"] }, client),
  ).toContain("Not available on Web");
  expect(
    clientCompatibilityReason({ clientPlatforms: ["web"] }, client),
  ).toBeUndefined();
});
