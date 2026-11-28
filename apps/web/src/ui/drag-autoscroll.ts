import { useCallback, useEffect, useRef } from "react";

/** How close (px) to the top or bottom edge a dragged card starts scrolling the list. */
export const EDGE_PX = 90;
/** Fastest scroll (px per frame), right at or past the edge. */
export const MAX_SPEED = 22;

/**
 * Scroll speed for a pointer at `y` in a visible area from `top` to `bottom`:
 * negative = up, positive = down, 0 = not near an edge. Faster the closer to
 * the edge (full speed at or past it).
 */
export function edgeSpeed(y: number, top: number, bottom: number, edge = EDGE_PX, max = MAX_SPEED): number {
  const zone = Math.min(edge, (bottom - top) / 3);
  if (zone <= 0) return 0;
  const ease = (d: number) => max * Math.max(0.15, Math.min(1, (zone - d) / zone));
  if (y < top + zone) return -ease(y - top);
  if (y > bottom - zone) return ease(bottom - y);
  return 0;
}

function scrollParent(el: Element | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

/**
 * The part of the screen where cards can be seen: a scrolling box (a dialog),
 * or the page below the top bar and sticky headers and above the tab bar.
 */
function visibleArea(box: HTMLElement | null): { top: number; bottom: number } {
  if (box) {
    const r = box.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  }
  let top = 0;
  let bottom = window.innerHeight;
  const vh = window.innerHeight;
  for (const el of document.querySelectorAll<HTMLElement>(".topbar, .priority-head")) {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.top < vh / 2 && getComputedStyle(el).position === "sticky") top = Math.max(top, r.bottom);
  }
  for (const el of document.querySelectorAll<HTMLElement>(".tabs-bottom")) {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && getComputedStyle(el).display !== "none" && r.top > vh / 2) bottom = Math.min(bottom, r.top);
  }
  return { top, bottom };
}

const pointerY = (e: Event): number | null => {
  if ("touches" in e) {
    const t = (e as TouchEvent).touches[0];
    return t ? t.clientY : null;
  }
  return "clientY" in e ? (e as PointerEvent).clientY : null;
};

/**
 * While a card is dragged, scroll its list when the card nears the top or
 * bottom of the visible area (faster closer to the edge). Pass `start` the
 * drag's activator event (DndContext onDragStart) and call `stop` when the
 * drag ends or is cancelled. Use with `autoScroll={false}` on the DndContext.
 */
export function useDragAutoScroll() {
  const state = useRef<{ off: () => void } | null>(null);

  const stop = useCallback(() => {
    state.current?.off();
    state.current = null;
  }, []);

  const start = useCallback(
    (activator: Event | null) => {
      stop();
      const target = activator?.target instanceof Element ? activator.target : null;
      const box = scrollParent(target);
      let y: number | null = activator ? pointerY(activator) : null;
      let frame = 0;
      const onMove = (e: Event) => {
        const v = pointerY(e);
        if (v !== null) y = v;
      };
      const step = () => {
        frame = requestAnimationFrame(step);
        if (y === null) return;
        const { top, bottom } = visibleArea(box);
        const v = edgeSpeed(y, top, bottom);
        if (v === 0) return;
        if (box) box.scrollTop += v;
        else window.scrollBy(0, v);
      };
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("touchmove", onMove, { passive: true });
      window.addEventListener("mousemove", onMove, { passive: true });
      frame = requestAnimationFrame(step);
      state.current = {
        off: () => {
          cancelAnimationFrame(frame);
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("touchmove", onMove);
          window.removeEventListener("mousemove", onMove);
        },
      };
    },
    [stop],
  );

  useEffect(() => stop, [stop]);
  return { start, stop };
}
