// SPDX-License-Identifier: MPL-2.0
import type { Directory, FileEntry, SessionServices } from "./sdk";
export type DeleteResult = {
  entry: Readonly<FileEntry>;
  status: "deleted" | "partial" | "failed";
  error?: string;
};
type DeleteServices = Pick<SessionServices, "removeEntry"> & {
  list(path: string): Promise<Pick<Directory, "path" | "entries">>;
};

/** Walk provider-owned paths only. A link is removed as a link, never traversed. */
async function deleteFolder(
  services: DeleteServices,
  root: Readonly<FileEntry>,
  canContinue: () => boolean,
  onDelete: () => void,
): Promise<boolean> {
  const visited = new Set<string>();
  const pending: { entry: Readonly<FileEntry>; contentsListed: boolean }[] = [
    { entry: root, contentsListed: false },
  ];
  while (pending.length) {
    if (!canContinue()) return false;
    const current = pending.pop()!;
    if (current.entry.kind === "directory" && !current.contentsListed) {
      if (visited.has(current.entry.path))
        throw new Error(
          "Folder listing contains a repeated path. Refresh before retrying.",
        );
      visited.add(current.entry.path);
      const directory = await services.list(current.entry.path);
      if (directory.path !== current.entry.path)
        throw new Error(
          "Folder location changed during deletion. Refresh before retrying.",
        );
      if (
        directory.entries.some((entry) => !entry.revision) ||
        new Set(directory.entries.map((entry) => entry.path)).size !==
          directory.entries.length
      )
        throw new Error(
          "Folder contents changed or lack revisions. Refresh before retrying.",
        );
      pending.push({ entry: current.entry, contentsListed: true });
      for (const entry of directory.entries.reverse())
        pending.push({ entry, contentsListed: false });
    } else {
      await services.removeEntry(current.entry.path, current.entry.revision!);
      onDelete();
    }
  }
  return true;
}

/** Sequential, revision-checked deletion; never retry an uncertain outcome. */
export async function deleteFiles(
  services: Pick<SessionServices, "removeEntry"> & Partial<DeleteServices>,
  entries: readonly Readonly<FileEntry>[],
  canContinue: () => boolean,
  report: (result: DeleteResult) => void,
  options: { recursive?: boolean; parent?: string } = {},
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
  if (options.recursive && !services.list)
    throw new Error(
      "This file provider cannot list folder contents for deletion.",
    );
  if (
    options.recursive &&
    entries.some((entry) => entry.kind === "directory")
  ) {
    if (!options.parent)
      throw new Error("Refresh the parent folder before deleting.");
    const parent = await services.list!(options.parent);
    if (parent.path !== options.parent)
      throw new Error("The parent folder changed. Refresh before deleting.");
    for (const entry of entries) {
      const current = parent.entries.find((item) => item.path === entry.path);
      if (
        !current ||
        current.revision !== entry.revision ||
        current.kind !== entry.kind
      )
        throw new Error(
          `${entry.name} changed. Refresh the folder before deleting.`,
        );
    }
  }
  for (const entry of entries) {
    if (!canContinue()) break;
    let deletedWithinFolder = 0;
    try {
      if (entry.kind === "directory" && options.recursive) {
        if (
          !(await deleteFolder(
            services as DeleteServices,
            entry,
            canContinue,
            () => deletedWithinFolder++,
          ))
        ) {
          report({ entry, status: "partial" });
          break;
        }
      } else await services.removeEntry(entry.path, entry.revision!);
      report({ entry, status: "deleted" });
    } catch (error) {
      report({
        entry,
        status: deletedWithinFolder ? "partial" : "failed",
        error: String(error),
      });
      break;
    }
  }
}
