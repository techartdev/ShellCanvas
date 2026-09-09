// SPDX-License-Identifier: MPL-2.0
import "./dialog-compat.css";

let fallback: typeof import("dialog-polyfill").default | undefined;

export async function prepareDialogs(): Promise<void> {
  if (
    typeof document !== "undefined" &&
    typeof document.createElement("dialog").showModal !== "function"
  ) {
    fallback = (await import("dialog-polyfill")).default;
  }
}

/** Keep native modal behavior; register the standard fallback on old WebKit. */
export function showModal(dialog: HTMLDialogElement | null): void {
  if (!dialog) return;
  if (typeof dialog.showModal !== "function") {
    if (!fallback) throw new Error("Dialog compatibility has not initialized.");
    dialog.classList.add("legacy-dialog");
    fallback.registerDialog(dialog);
  }
  if (!dialog.open) dialog.showModal();
}
