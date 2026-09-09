// SPDX-License-Identifier: MPL-2.0
import { isTauri } from "@tauri-apps/api/core";
import { Image } from "@tauri-apps/api/image";
import { readImage, writeImage } from "@tauri-apps/plugin-clipboard-manager";
import type { ClipboardImage } from "../packages/app-sdk/src/clipboard-image";

export async function readClipboardImage(): Promise<ClipboardImage> {
  if (isTauri()) {
    const image = await readImage();
    try {
      const { width, height } = await image.size();
      return { width, height, rgba: await image.rgba() };
    } finally {
      await image.close();
    }
  }
  for (const item of await navigator.clipboard.read()) {
    if (!item.types.includes("image/png")) continue;
    const bitmap = await createImageBitmap(await item.getType("image/png"));
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, bitmap.width, bitmap.height);
      return {
        width: bitmap.width,
        height: bitmap.height,
        rgba: new Uint8Array(data.data),
      };
    } finally {
      bitmap.close();
    }
  }
  throw new Error("No PNG image is available on the clipboard.");
}
export async function writeClipboardImage(
  image: ClipboardImage,
): Promise<void> {
  if (isTauri()) {
    const nativeImage = await Image.new(image.rgba, image.width, image.height);
    try {
      await writeImage(nativeImage);
    } finally {
      await nativeImage.close();
    }
    return;
  }
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas
    .getContext("2d")!
    .putImageData(
      new ImageData(
        new Uint8ClampedArray(image.rgba),
        image.width,
        image.height,
      ),
      0,
      0,
    );
  const png = await canvas.convertToBlob({ type: "image/png" });
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
