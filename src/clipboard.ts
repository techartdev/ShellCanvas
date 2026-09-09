// SPDX-License-Identifier: MPL-2.0
import { isTauri } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { readClipboardImage, writeClipboardImage } from "./clipboard-image";
import type { ClipboardImage } from "../packages/app-sdk/src/clipboard-image";

export interface ClipboardService {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  readImage?(): Promise<ClipboardImage>;
  writeImage?(image: ClipboardImage): Promise<void>;
}
// Reads are explicit operations; this service never monitors or polls the clipboard.
export const clipboard: ClipboardService = {
  readImage: readClipboardImage,
  writeImage: writeClipboardImage,
  readText: () => (isTauri() ? readText() : navigator.clipboard.readText()),
  writeText: (text) =>
    isTauri() ? writeText(text) : navigator.clipboard.writeText(text),
};
