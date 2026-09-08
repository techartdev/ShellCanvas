// SPDX-License-Identifier: MPL-2.0
import type { Preferences } from "./preferences";
import type { FileEntry } from "./sdk";

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
