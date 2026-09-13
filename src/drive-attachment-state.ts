// SPDX-License-Identifier: MPL-2.0
import type { ConnectionIdentity } from "./sdk";
import type { DriveMapping } from "./components/DriveMappings";

export function attachmentsForLocation(
  mappings: readonly DriveMapping[],
  sessionId: number | undefined,
  source: ConnectionIdentity | null | undefined,
  path: string,
  windows: boolean,
): DriveMapping[] {
  if (sessionId === undefined || !source) return [];
  const normalize = (value: string) => {
    if (windows)
      value = value
        .replace(/\\/g, "/")
        .replace(/^\/([a-z]:)/i, "$1")
        .toLowerCase();
    return value.replace(/\/+$/, "") || "/";
  };
  return mappings.filter(
    (item) =>
      (item.running || item.canRetryCleanup) &&
      item.sessionId === sessionId &&
      item.source.instance === source.instance &&
      item.source.generation === source.generation &&
      item.source.adapter === source.adapter &&
      normalize(item.remotePath) === normalize(path),
  );
}
