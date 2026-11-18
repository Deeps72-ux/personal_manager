/**
 * Zoom and pan a time axis by hand, on one chart surface:
 *   mouse      drag = pan · wheel = zoom at the cursor · double-click = zoom in
 *   trackpad   two-finger swipe sideways = pan · pinch = zoom
 *   touch      one finger sideways = pan · pinch = zoom (vertical swipes still scroll the page)
 *   tap/click  (no movement) = pick the nearest point
 */
import { clampWindow, panWindow, zoomWindow, type Window } from "../core/insights.ts";

export interface GestureTarget {
  view(): Window;
  setView(w: Window): void;
  /** Plot area in client pixels. */
  plot(): { left: number; width: number };
  tap(clientX: number): void;
  hover(clientX: number | null): void;
}

const MOVE_SLOP = 5; // px before a press becomes a drag

export function attachTimeGestures(el: Element, g: GestureTarget): () => void {
  const pointers = new Map<number, number>(); // pointerId → clientX
  let pan: { x: number; view: Window; moved: boolean } | null = null;
  let pinch: { t1: number; t2: number } | null = null;

  const timeAt = (x: number, w: Window) => {
    const p = g.plot();
    return w.start + ((x - p.left) / p.width) * (w.end - w.start);
  };

  const startPan = (x: number, moved: boolean) => {
    pan = { x, view: g.view(), moved };
  };

  const down = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pointers.set(e.pointerId, e.clientX);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events in tests have no active pointer
    }
    if (pointers.size === 1) {
      startPan(e.clientX, false);
      pinch = null;
    } else if (pointers.size === 2) {
      const [x1, x2] = [...pointers.values()] as [number, number];
      const w = g.view();
      pinch = { t1: timeAt(x1, w), t2: timeAt(x2, w) };
      pan = null;
    }
  };

  const move = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType === "mouse") g.hover(e.clientX);
      return;
    }
    pointers.set(e.pointerId, e.clientX);
    if (pinch && pointers.size >= 2) {
      const [x1, x2] = [...pointers.values()] as [number, number];
      if (Math.abs(x2 - x1) < 12) return;
      // Keep the two times that were under the fingers under the fingers.
      const p = g.plot();
      const msPerPx = (pinch.t2 - pinch.t1) / (x2 - x1);
      if (msPerPx <= 0) return;
      const start = pinch.t1 - (x1 - p.left) * msPerPx;
      g.setView(clampWindow({ start, end: start + p.width * msPerPx }));
      return;
    }
    if (pan) {
      const dx = e.clientX - pan.x;
      if (!pan.moved && Math.abs(dx) < MOVE_SLOP) return;
      pan.moved = true;
      const w = pan.view;
      g.setView(panWindow(w, (-dx / g.plot().width) * (w.end - w.start)));
    }
  };

  const up = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    const wasTap = e.type === "pointerup" && pointers.size === 1 && pan !== null && !pan.moved;
    pointers.delete(e.pointerId);
    if (wasTap) g.tap(e.clientX);
    if (pointers.size === 1) {
      // Lifted one finger of a pinch: carry on panning with the other.
      startPan([...pointers.values()][0]!, true);
      pinch = null;
    } else if (pointers.size === 0) {
      pan = null;
      pinch = null;
    }
  };

  const leave = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && pointers.size === 0) g.hover(null);
  };

  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const w = g.view();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1; // lines / pages → px
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (Math.abs(dx) > Math.abs(dy)) {
      g.setView(panWindow(w, (dx / g.plot().width) * (w.end - w.start)));
    } else {
      // ctrlKey = trackpad pinch: small deltas, so zoom faster per unit.
      g.setView(zoomWindow(w, Math.exp(dy * (e.ctrlKey ? 0.01 : 0.0015)), timeAt(e.clientX, w)));
    }
  };

  const dbl = (e: MouseEvent) => {
    const w = g.view();
    g.setView(zoomWindow(w, 0.5, timeAt(e.clientX, w)));
  };

  el.addEventListener("pointerdown", down as EventListener);
  el.addEventListener("pointermove", move as EventListener);
  el.addEventListener("pointerup", up as EventListener);
  el.addEventListener("pointercancel", up as EventListener);
  el.addEventListener("pointerleave", leave as EventListener);
  el.addEventListener("wheel", wheel as EventListener, { passive: false });
  el.addEventListener("dblclick", dbl as EventListener);
  return () => {
    el.removeEventListener("pointerdown", down as EventListener);
    el.removeEventListener("pointermove", move as EventListener);
    el.removeEventListener("pointerup", up as EventListener);
    el.removeEventListener("pointercancel", up as EventListener);
    el.removeEventListener("pointerleave", leave as EventListener);
    el.removeEventListener("wheel", wheel as EventListener);
    el.removeEventListener("dblclick", dbl as EventListener);
  };
}
