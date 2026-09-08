// SPDX-License-Identifier: MPL-2.0
import type { Directory, FileRelocation } from "./sdk";
export interface FileNavigation {
  directory: Directory;
  history: string[];
  pathInput: string;
  selected: string | null;
  document: { name: string; path: string; text: string } | null;
}
export function trackedNavigation(view: FileNavigation): string[] {
  return [
    ...new Set(
      [
        view.directory.path,
        view.directory.parent,
        view.directory.home?.path,
        ...view.directory.roots.map((root) => root.path),
        ...view.history,
        view.selected,
        view.document?.path,
      ].filter((path): path is string => !!path),
    ),
  ];
}
/** Map only explicit provider identities; never infer a path prefix or separator. */
export function relocateNavigation(
  view: FileNavigation,
  locations: FileRelocation["locations"],
): FileNavigation {
  const mapping = new Map(
    locations.map((item) => [item.previous, item.location]),
  );
  const path = (value: string) => mapping.get(value)?.path ?? value;
  const moved = mapping.get(view.directory.path);
  return {
    directory: {
      ...view.directory,
      ...moved,
      parent: moved
        ? moved.parent
        : view.directory.parent === null
          ? null
          : path(view.directory.parent),
      home: view.directory.home
        ? { ...view.directory.home, path: path(view.directory.home.path) }
        : null,
      roots: view.directory.roots.map((root) => ({
        ...root,
        path: path(root.path),
      })),
      // The fresh listing supplies child metadata; old entries cannot be used at
      // a new directory identity while that request is pending.
      entries: moved ? [] : view.directory.entries,
    },
    history: view.history.map(path),
    pathInput:
      view.pathInput === view.directory.path
        ? path(view.pathInput)
        : view.pathInput,
    selected: view.selected === null ? null : path(view.selected),
    document: view.document
      ? { ...view.document, ...mapping.get(view.document.path) }
      : null,
  };
}
