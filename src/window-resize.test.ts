// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import { resizeRectangle, type ResizeEdge } from "./window-resize";

const start = { left: 100, top: 80, width: 500, height: 400 };
const bounds = { width: 1200, height: 800 };
const minimum = { width: 350, height: 260 };
const resize = (edge: ResizeEdge, dx: number, dy: number) =>
  resizeRectangle(start, edge, dx, dy, bounds, minimum);

describe("desktop window resizing", () => {
  it.each([
    ["n", { left: 100, top: 110, width: 500, height: 370 }],
    ["ne", { left: 100, top: 110, width: 520, height: 370 }],
    ["e", { left: 100, top: 80, width: 520, height: 400 }],
    ["se", { left: 100, top: 80, width: 520, height: 430 }],
    ["s", { left: 100, top: 80, width: 500, height: 430 }],
    ["sw", { left: 120, top: 80, width: 480, height: 430 }],
    ["w", { left: 120, top: 80, width: 480, height: 400 }],
    ["nw", { left: 120, top: 110, width: 480, height: 370 }],
  ] as const)(
    "resizes %s while keeping opposite edges anchored",
    (edge, expected) => {
      expect(resize(edge, 20, 30)).toEqual(expected);
    },
  );
  it("clamps large, single-event drags to the work area", () => {
    expect(resize("nw", -5000, -5000)).toEqual({
      left: 0,
      top: 0,
      width: 600,
      height: 480,
    });
    expect(resize("se", 5000, 5000)).toEqual({
      left: 100,
      top: 80,
      width: 1100,
      height: 720,
    });
  });
  it("stops shrinking at the minimum without moving the opposite edge", () => {
    expect(resize("nw", 5000, 5000)).toEqual({
      left: 250,
      top: 220,
      ...minimum,
    });
    expect(resize("se", -5000, -5000)).toEqual({
      left: 100,
      top: 80,
      ...minimum,
    });
  });
  it("uses the original pointer offset when reversing from a boundary", () => {
    resize("w", -5000, 0);
    expect(resize("w", -50, 0)).toEqual({
      left: 50,
      top: 80,
      width: 550,
      height: 400,
    });
  });
  it("handles a work area that becomes smaller during the drag", () => {
    expect(
      resizeRectangle(
        start,
        "se",
        1000,
        1000,
        { width: 300, height: 200 },
        minimum,
      ),
    ).toEqual({ left: 100, top: 80, width: 200, height: 120 });
  });
});
