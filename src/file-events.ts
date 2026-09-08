// SPDX-License-Identifier: MPL-2.0
const listeners = new Map<number, Set<() => void>>();
export function watchFileChanges(sessionId: number, listener: () => void) {
  const group = listeners.get(sessionId) ?? new Set<() => void>();
  group.add(listener);
  listeners.set(sessionId, group);
  return () => {
    group.delete(listener);
    if (!group.size) listeners.delete(sessionId);
  };
}
export function notifyFileChanges(sessionId: number) {
  listeners.get(sessionId)?.forEach((listener) => listener());
}
