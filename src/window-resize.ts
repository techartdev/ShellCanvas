// SPDX-License-Identifier: MPL-2.0
export const resizeEdges = [
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
  "nw",
] as const;
export type ResizeEdge = (typeof resizeEdges)[number];
export interface WindowRectangle {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Keep the opposite edge fixed, limiting growth to the desktop's work area.
export function resizeRectangle(
  start: WindowRectangle,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  bounds: { width: number; height: number },
  minimum: { width: number; height: number },
): WindowRectangle {
  const clamp = (value: number, low: number, high: number) =>
    Math.min(high, Math.max(low, value));
  let left = clamp(start.left, 0, bounds.width);
  let top = clamp(start.top, 0, bounds.height);
  let right = clamp(start.left + start.width, left, bounds.width);
  let bottom = clamp(start.top + start.height, top, bounds.height);
  if (edge.includes("w"))
    left = clamp(start.left + dx, 0, Math.max(0, right - minimum.width));
  if (edge.includes("e"))
    right = clamp(
      start.left + start.width + dx,
      Math.min(bounds.width, left + minimum.width),
      bounds.width,
    );
  if (edge.includes("n"))
    top = clamp(start.top + dy, 0, Math.max(0, bottom - minimum.height));
  if (edge.includes("s"))
    bottom = clamp(
      start.top + start.height + dy,
      Math.min(bounds.height, top + minimum.height),
      bounds.height,
    );
  return { left, top, width: right - left, height: bottom - top };
}
