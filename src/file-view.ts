// SPDX-License-Identifier: MPL-2.0
import type { Preferences } from "./preferences";
import type { FileEntry } from "./sdk";

export type DirectoryActivation =
  | { status: "opened" }
  | { status: "failed"; error: unknown }
  | { status: "canceled" };
export interface PreviewActivation {
  linkFallback: boolean;
  directoryError?: unknown;
}

/** Resolve an entry only when activated; listings keep links isolated as links. */
export async function activateFileEntry(
  entry: FileEntry,
  openDirectory: (
    path: string,
    options: { linkProbe: boolean },
  ) => Promise<DirectoryActivation>,
  preview: (entry: FileEntry, options: PreviewActivation) => Promise<void>,
) {
  if (entry.kind === "directory") {
    await openDirectory(entry.path, { linkProbe: false });
    return;
  }
  if (entry.kind === "symlink") {
    const result = await openDirectory(entry.path, { linkProbe: true });
    if (result.status === "failed")
      await preview(entry, {
        linkFallback: true,
        directoryError: result.error,
      });
    return;
  }
  await preview(entry, { linkFallback: false });
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function fileLinkOpenError(
  directoryError: unknown,
  previewError: unknown,
) {
  return `Cannot open link: folder access failed (${errorMessage(directoryError)}); file preview failed (${errorMessage(previewError)}).`;
}

export function formatFileModified(
  modified: number | null,
  locales?: Intl.LocalesArgument,
) {
  return !modified
    ? "—"
    : new Date(modified * 1000).toLocaleDateString(locales, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

/** Sorting changes only the view; never mutate provider-owned directory data. */
export function visibleFiles(
  entries: readonly FileEntry[],
  query: string,
  preferences: Pick<
    Preferences,
    "filesShowHidden" | "filesFoldersFirst" | "filesSort" | "filesDescending"
  >,
) {
  const direction = preferences.filesDescending ? -1 : 1;
  const names = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  return entries
    .filter(
      (entry) =>
        (preferences.filesShowHidden || !entry.name.startsWith(".")) &&
        entry.name.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((left, right) => {
      if (
        preferences.filesFoldersFirst &&
        (left.kind === "directory") !== (right.kind === "directory")
      )
        return left.kind === "directory" ? -1 : 1;
      let comparison = 0;
      if (preferences.filesSort === "modified") {
        // Unknown dates remain at the end in either direction.
        if ((left.modified === null) !== (right.modified === null))
          return left.modified === null ? 1 : -1;
        comparison = (left.modified ?? 0) - (right.modified ?? 0);
      } else if (preferences.filesSort === "size")
        comparison = left.size - right.size;
      return (
        direction *
        (comparison ||
          names.compare(left.name, right.name) ||
          left.path.localeCompare(right.path))
      );
    });
}
