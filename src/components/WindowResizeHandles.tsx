// SPDX-License-Identifier: MPL-2.0
import {
  useEffect,
  useRef,
  useState,
  type RefObject,
  type PointerEvent,
} from "react";
import {
  resizeEdges,
  resizeRectangle,
  type ResizeEdge,
  type WindowRectangle,
} from "../window-resize";

export function WindowResizeHandles({
  element,
  resize,
}: {
  element: RefObject<HTMLElement | null>;
  resize(rectangle: WindowRectangle): void;
}) {
  const [active, setActive] = useState<ResizeEdge | null>(null);
  const gesture = useRef<{
    target: HTMLElement;
    pointerId: number;
    edge: ResizeEdge;
    x: number;
    y: number;
    start: WindowRectangle;
    minimum: { width: number; height: number };
  } | null>(null);
  const finish = () => {
    const previous = gesture.current;
    gesture.current = null;
    if (previous?.target.hasPointerCapture(previous.pointerId))
      previous.target.releasePointerCapture(previous.pointerId);
    setActive(null);
  };
  useEffect(() => {
    window.addEventListener("blur", finish);
    return () => {
      window.removeEventListener("blur", finish);
      const previous = gesture.current;
      gesture.current = null;
      if (previous?.target.hasPointerCapture(previous.pointerId))
        previous.target.releasePointerCapture(previous.pointerId);
    };
  }, []);
  const update = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    const parent = element.current?.parentElement;
    if (!current || event.pointerId !== current.pointerId || !parent) return;
    resize(
      resizeRectangle(
        current.start,
        current.edge,
        event.clientX - current.x,
        event.clientY - current.y,
        { width: parent.clientWidth, height: parent.clientHeight },
        current.minimum,
      ),
    );
  };
  return (
    <>
      {active && (
        <div
          className="window-resize-shield"
          style={{ cursor: `${active}-resize` }}
          aria-hidden="true"
        />
      )}
      {resizeEdges.map((edge) => (
        <div
          key={edge}
          className={`window-resize-handle resize-${edge}`}
          data-resize-edge={edge}
          aria-hidden="true"
          onPointerDown={(event) => {
            if (
              event.button !== 0 ||
              !event.isPrimary ||
              gesture.current ||
              !element.current
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            const el = element.current;
            const rect = el.getBoundingClientRect();
            const bounds = el.parentElement!.getBoundingClientRect();
            const style = getComputedStyle(el);
            event.currentTarget.setPointerCapture(event.pointerId);
            gesture.current = {
              target: event.currentTarget,
              pointerId: event.pointerId,
              edge,
              x: event.clientX,
              y: event.clientY,
              start: {
                left: rect.left - bounds.left,
                top: rect.top - bounds.top,
                width: rect.width,
                height: rect.height,
              },
              minimum: {
                width: parseFloat(style.minWidth) || 0,
                height: parseFloat(style.minHeight) || 0,
              },
            };
            setActive(edge);
          }}
          onPointerMove={update}
          onPointerUp={(event) => {
            if (event.pointerId !== gesture.current?.pointerId) return;
            update(event);
            finish();
          }}
          onPointerCancel={(event) => {
            if (event.pointerId === gesture.current?.pointerId) finish();
          }}
          onLostPointerCapture={(event) => {
            if (event.pointerId === gesture.current?.pointerId) finish();
          }}
        />
      ))}
    </>
  );
}
