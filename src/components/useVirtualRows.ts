// SPDX-License-Identifier: MPL-2.0
import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** A bounded DOM window over the complete discovered inventory. */
export function useVirtualRows(count: number) {
  const [element, attach] = useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({
    top: 0,
    height: 600,
    row: 40,
    offset: 0,
  });
  const pendingFocus = useRef<number | null>(null);
  const measure = useCallback(() => {
    if (!element) return;
    const first = element.querySelector<HTMLElement>("[data-virtual-index]");
    setViewport((old) => {
      const row = first
        ? first.getBoundingClientRect().height +
          (parseFloat(getComputedStyle(first).marginBottom) || 0)
        : old.row;
      const offset = first
        ? first.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          element.clientTop +
          element.scrollTop -
          Number(first.dataset.virtualIndex) * row
        : old.offset;
      const next = {
        top: element.scrollTop,
        height: element.clientHeight || old.height,
        row: row || old.row,
        offset,
      };
      return Object.keys(next).every(
        (key) =>
          Math.abs(
            next[key as keyof typeof next] - old[key as keyof typeof old],
          ) < 0.5,
      )
        ? old
        : next;
    });
  }, [element]);
  useLayoutEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", measure);
    };
  }, [element, measure]);
  const visible = Math.ceil(viewport.height / viewport.row) + 12;
  const start = Math.min(
    Math.max(0, count - visible),
    Math.max(
      0,
      Math.floor((viewport.top - viewport.offset) / viewport.row) - 6,
    ),
  );
  const end = Math.min(count, start + visible);
  useLayoutEffect(() => {
    measure();
    if (pendingFocus.current !== null) {
      const row = element?.querySelector<HTMLElement>(
        `[data-virtual-index="${pendingFocus.current}"]`,
      );
      if (row) {
        row.focus({ preventScroll: true });
        pendingFocus.current = null;
      }
    }
  });
  const focus = (index: number) => {
    if (!element || index < 0 || index >= count) return;
    const row = element.querySelector<HTMLElement>(
      `[data-virtual-index="${index}"]`,
    );
    if (row) {
      row.focus();
      return;
    }
    pendingFocus.current = index;
    const top = Math.max(
      0,
      viewport.offset + index * viewport.row - viewport.height / 2,
    );
    element.scrollTop = top;
    setViewport((old) => ({ ...old, top: element.scrollTop }));
  };
  return {
    attach,
    start,
    end,
    before: start * viewport.row,
    after: (count - end) * viewport.row,
    focus,
  };
}
