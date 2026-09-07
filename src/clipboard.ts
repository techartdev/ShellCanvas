// SPDX-License-Identifier: MPL-2.0
import { isTauri } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

export interface ClipboardService {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}
// Reads happen only in response to Paste; never monitor the clipboard.
export const clipboard: ClipboardService = {
  readText: () => (isTauri() ? readText() : navigator.clipboard.readText()),
  writeText: (text) =>
    isTauri() ? writeText(text) : navigator.clipboard.writeText(text),
};
