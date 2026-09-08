// SPDX-License-Identifier: MPL-2.0
import type { FileRelocation } from "./sdk";
type FileChange = "content" | "relocation";
const listeners = new Map<number, Set<(kind: FileChange) => void>>();
export function watchFileChanges(
  sessionId: number,
  listener: (kind: FileChange) => void,
) {
  const group =
    listeners.get(sessionId) ?? new Set<(kind: FileChange) => void>();
  group.add(listener);
  listeners.set(sessionId, group);
  return () => {
    group.delete(listener);
    if (!group.size) listeners.delete(sessionId);
  };
}
export function notifyFileChanges(
  sessionId: number,
  kind: FileChange = "content",
) {
  listeners.get(sessionId)?.forEach((listener) => listener(kind));
}

interface LocationWatcher {
  snapshot(): { paths: string[]; busy: boolean };
  pending(value: boolean): void;
  relocated(locations: FileRelocation["locations"]): void;
}
const locations = new Map<number, Set<LocationWatcher>>();
const relocating = new Set<number>();
export function watchFileLocations(
  sessionId: number,
  watcher: LocationWatcher,
) {
  const group = locations.get(sessionId) ?? new Set<LocationWatcher>();
  group.add(watcher);
  locations.set(sessionId, group);
  return () => {
    group.delete(watcher);
    if (!group.size) locations.delete(sessionId);
  };
}
/** Freeze tracked views for one confirmed operation; drafts never reload. */
export function beginFileRelocation(
  sessionId: number,
  additionalPaths: string[] = [],
) {
  if (relocating.has(sessionId))
    throw new Error(
      "Another file move is still running. Try again when it finishes.",
    );
  const participants = [...(locations.get(sessionId) ?? [])];
  const snapshots = participants.map((w) => w.snapshot());
  if (snapshots.some((s) => s.busy))
    throw new Error(
      "Wait for file transfers and editor operations or dialogs to finish before moving or renaming files.",
    );
  const tracked = [
    ...new Set([...snapshots.flatMap((s) => s.paths), ...additionalPaths]),
  ];
  if (tracked.length > 256)
    throw new Error(
      "Too many open file locations to follow this move (maximum 256).",
    );
  relocating.add(sessionId);
  participants.forEach((w) => w.pending(true));
  return {
    tracked,
    apply(result: FileRelocation) {
      participants.forEach((w) => {
        if (locations.get(sessionId)?.has(w)) w.relocated(result.locations);
      });
    },
    finish() {
      relocating.delete(sessionId);
      participants.forEach((w) => {
        if (locations.get(sessionId)?.has(w)) w.pending(false);
      });
    },
  };
}
