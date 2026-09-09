// SPDX-License-Identifier: MPL-2.0
import { beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  size: vi.fn(),
  rgba: vi.fn(),
  close: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/image", () => ({ Image: { new: native.create } }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readImage: native.read,
  writeImage: native.write,
}));
import { readClipboardImage, writeClipboardImage } from "./clipboard-image";
beforeEach(() => {
  vi.resetAllMocks();
  native.read.mockResolvedValue(native);
  native.create.mockResolvedValue(native);
  native.size.mockResolvedValue({ width: 1, height: 1 });
  native.rgba.mockResolvedValue(new Uint8Array([1, 2, 3, 255]));
});
it("releases native image resources after a read and after failed pixel extraction", async () => {
  expect(await readClipboardImage()).toEqual({
    width: 1,
    height: 1,
    rgba: new Uint8Array([1, 2, 3, 255]),
  });
  expect(native.close).toHaveBeenCalledTimes(1);
  native.rgba.mockRejectedValueOnce(new Error("read failed"));
  await expect(readClipboardImage()).rejects.toThrow("read failed");
  expect(native.close).toHaveBeenCalledTimes(2);
});
it("publishes one native resource and releases it even when OS publication fails", async () => {
  const image = { width: 1, height: 1, rgba: new Uint8Array([1, 2, 3, 255]) };
  await writeClipboardImage(image);
  expect(native.create).toHaveBeenCalledWith(image.rgba, 1, 1);
  expect(native.write).toHaveBeenCalledWith(native);
  expect(native.close).toHaveBeenCalledTimes(1);
  native.write.mockRejectedValueOnce(new Error("publication failed"));
  await expect(writeClipboardImage(image)).rejects.toThrow(
    "publication failed",
  );
  expect(native.close).toHaveBeenCalledTimes(2);
  expect(native.write).toHaveBeenCalledTimes(2);
});
