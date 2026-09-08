// SPDX-License-Identifier: MPL-2.0
// Synthetic POSIX provider mapping, never imported by desktop applications.
import type { FileRelocation } from "../../src/sdk";
export function posixRelocation(
  source: string,
  destination: string,
  tracked: string[],
  directory: boolean,
): FileRelocation {
  return {
    path: destination,
    locations: tracked
      .filter(
        (path) =>
          path === source || (directory && path.startsWith(`${source}/`)),
      )
      .map((previous) => {
        const path = destination + previous.slice(source.length);
        return {
          previous,
          location: {
            path,
            name: path.split("/").at(-1)!,
            parent: path.slice(0, path.lastIndexOf("/")) || "/",
          },
        };
      }),
  };
}
