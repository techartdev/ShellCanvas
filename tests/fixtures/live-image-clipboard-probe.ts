// SPDX-License-Identifier: MPL-2.0
// Manual opt-in only: exchanges two tiny opaque images with the Windows runner.
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { clipboard } from "../../src/clipboard";

const outgoing = new Uint8Array([
  255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
]);
const incoming = new Uint8Array([
  0, 0, 0, 255, 255, 255, 0, 255, 0, 255, 255, 255, 255, 0, 255, 255,
]);
const matches = (
  image: Awaited<ReturnType<NonNullable<typeof clipboard.readImage>>>,
  bytes: Uint8Array,
) =>
  image.width === 2 &&
  image.height === 2 &&
  image.rgba.length === bytes.length &&
  image.rgba.every((value, i) => value === bytes[i]);

async function run() {
  await invoke("live_clipboard_probe_context");
  await clipboard.writeImage!({ width: 2, height: 2, rgba: outgoing });
  if (!matches(await clipboard.readImage!(), outgoing))
    throw new Error("Native image round trip changed pixels");
  await emit("shellcanvas-native-extension-progress", {
    stage: "live-image-written",
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if (matches(await clipboard.readImage!(), incoming))
        return {
          success: true,
          checks: {
            nativeImageRoundTrip: true,
            windowsProducedImageRead: true,
          },
          scope:
            "Actual Windows clipboard and production native image service; 2x2 opaque RGBA only",
        };
    } catch {
      // The other process can own the clipboard briefly while publishing.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Windows-produced test image was not observed");
}
void run()
  .catch((error) => ({ success: false, error: String(error) }))
  .then(async (result) => {
    document.getElementById("status")!.textContent = JSON.stringify(result);
    await emit("shellcanvas-native-extension-probe", result);
  });
