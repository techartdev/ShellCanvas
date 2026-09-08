// SPDX-License-Identifier: MPL-2.0
import type { FileEntry, SessionServices } from "./sdk";
export type DeleteResult = {
  entry: Readonly<FileEntry>;
  status: "deleted" | "failed";
  error?: string;
};
/** Sequential, revision-checked deletion; never retry an uncertain outcome. */
export async function deleteFiles(
  services: Pick<SessionServices, "removeEntry">,
  entries: readonly Readonly<FileEntry>[],
  canContinue: () => boolean,
  report: (result: DeleteResult) => void,
) {
  if (
    !entries.length ||
    entries.length > 100 ||
    entries.some((entry) => !entry.revision) ||
    new Set(entries.map((entry) => entry.path)).size !== entries.length
  )
    throw new Error(
      "Choose up to 100 distinct items with current revisions. Refresh the folder first.",
    );
  for (const entry of entries) {
    if (!canContinue()) break;
    try {
      await services.removeEntry(entry.path, entry.revision!);
      report({ entry, status: "deleted" });
    } catch (error) {
      report({ entry, status: "failed", error: String(error) });
      break;
    }
  }
}
