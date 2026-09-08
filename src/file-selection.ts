// SPDX-License-Identifier: MPL-2.0
/** Selection follows the visible order; provider locations are opaque identities. */
export function selectFiles(
  current: readonly string[],
  order: readonly string[],
  target: string,
  anchor: string | null,
  toggle = false,
  range = false,
): string[] {
  const visible = new Set(order);
  const kept = current.filter((path) => visible.has(path));
  if (!visible.has(target)) return kept;
  if (range && anchor && visible.has(anchor)) {
    const a = order.indexOf(anchor),
      b = order.indexOf(target);
    const span = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    return toggle ? [...new Set([...kept, ...span])] : span;
  }
  if (toggle)
    return kept.includes(target)
      ? kept.filter((path) => path !== target)
      : [...kept, target];
  return [target];
}
