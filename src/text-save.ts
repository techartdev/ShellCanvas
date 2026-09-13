// SPDX-License-Identifier: MPL-2.0
import type { SessionServices, TextDocument } from "./sdk";

export const nonAtomicSaveWarning =
  "Atomic saving with permission preservation is unavailable on this server. Saving writes directly to the existing file. If the connection or device fails during saving, the file may be incomplete or corrupted. Save As with a new name keeps the original. Continue with this save?";

export async function saveTextWithConfirmation(
  services: SessionServices,
  document: TextDocument,
  text: string,
  confirm: () => Promise<boolean>,
  isCurrent: () => boolean,
): Promise<TextDocument | null> {
  if (document.saveRequiresConfirmation) {
    if (!(await confirm()) || !isCurrent()) return null;
    return services.saveText(document.path, text, document.revision, true);
  }
  if (!isCurrent()) return null;
  return services.saveText(document.path, text, document.revision);
}
