import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { formatSeconds } from "@pm/shared";
import { cutAt, isMovableCut, mergeCut, MIN_PIECE_MS, moveCut, pieceAt, splitAt, type Segment } from "../core/split.ts";
import { pad2 } from "../core/views.ts";

const clock = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const MINUTE = 60_000;
/** The closest zoom: 15 minutes across the bar (or the whole span if shorter). */
export const MIN_VIEW_MS = 15 * MINUTE;
/** Two taps this close (time, px) are a double-tap: a cut. A lone tap waits this long, then picks. */
export const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;
const TAP_SLOP = 8; // px before a press becomes a pan
const MERGE_PX = 12; // a divider dragged this close to its neighbour's far edge merges
const CUT_LABEL_PX = 44;

export interface TimeWindow {
  start: number;
  end: number;
}

/** `v` kept inside `span`, at least MIN_VIEW_MS wide (or the whole span). */
export function clampView(v: TimeWindow, span: TimeWindow): TimeWindow {
  const spanW = Math.max(1, span.end - span.start);
  const w = Math.min(spanW, Math.max(Math.min(MIN_VIEW_MS, spanW), v.end - v.start));
  const start = Math.min(span.end - w, Math.max(span.start, v.start));
  return { start, end: start + w };
}

const STEPS_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 720];

/** Clock ticks for the view: finer as it zooms in (at least `gapPx` apart), on round local times. */
export function tickTimes(view: TimeWindow, px: number, gapPx = 56): number[] {
  const w = Math.max(1, view.end - view.start);
  const width = px > 0 ? px : 600;
  const step = (STEPS_MIN.find((m) => ((m * MINUTE) / w) * width >= gapPx) ?? 720) * MINUTE;
  const d = new Date(view.start);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const out: number[] = [];
  for (let t = midnight + Math.ceil((view.start - midnight) / step) * step; t <= view.end; t += step) out.push(t);
  return out;
}

/** The text box of the picked piece, typed straight into the bar. */
export interface PieceInput {
  ref: RefObject<HTMLInputElement | null>;
  label: (seg: Segment) => string;
  placeholder: string;
  maxLength: number;
  onText: (v: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}

type Gesture = {
  pointers: Map<number, number>; // pointerId → clientX
  press: { x: number; moved: boolean } | null;
  pan: { x: number; view: TimeWindow } | null;
  pinch: { t1: number; t2: number } | null;
  lastTap: { at: number; x: number } | null;
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * SPLIT BAR: a span of time as coloured pieces side by side.
 *
 *   double-tap      cut there (whole minute; nudged 1 minute off a divider or edge)
 *   tap             pick the piece, then type its activity right in the bar
 *   drag a divider  move it (its clock time and both lengths float above);
 *                   drag it onto the neighbour's far edge to merge the two
 *   pinch / Ctrl+scroll   zoom (down to 15 minutes across); drag sideways to pan
 *
 * Every divider's clock time is written above the bar, clock ticks below it.
 * Locked pieces (time already taken) are faded and cannot be picked or cut.
 * Keyboard: a piece is picked with Enter, "/" cuts it in two; a divider
 * moves with ←/→ (Shift: 15 min) and Delete merges its two pieces.
 */
export function SplitBar({
  segs,
  selected,
  onSelect,
  onChange,
  label,
  hueOf,
  input,
}: {
  segs: readonly Segment[];
  /** The picked piece, -1 for none. */
  selected: number;
  onSelect: (i: number) => void;
  /** New pieces, and the piece to pick (-1: none) if it changes. */
  onChange: (segs: Segment[], selected?: number) => void;
  label: string;
  /** Colour of a piece: a hue, or null for neutral. Unlogged pieces are red. */
  hueOf: (s: Segment) => number | null;
  input: PieceInput;
}) {
  const span: TimeWindow = { start: segs[0]?.start ?? 0, end: segs.at(-1)?.end ?? 1 };
  const [view, setViewState] = useState<TimeWindow>(span);
  const [px, setPx] = useState(0);
  const [drag, setDrag] = useState<{ i: number; merge: "left" | "right" | null } | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const g = useRef<Gesture>({ pointers: new Map(), press: null, pan: null, pinch: null, lastTap: null, timer: null });
  // The latest props, for the delayed single tap and the wheel listener.
  const live = useRef({ segs, onSelect, view, span });
  useLayoutEffect(() => {
    live.current = { segs, onSelect, view, span };
  });

  const setView = (v: TimeWindow) => setViewState(clampView(v, live.current.span));

  // A new span (another day, a restarted timer): show all of it.
  useEffect(() => {
    setViewState({ start: span.start, end: span.end });
  }, [span.start, span.end]);

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    setPx(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => e && setPx(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => void (g.current.timer && clearTimeout(g.current.timer)), []);

  const timeAt = (clientX: number, v: TimeWindow = live.current.view): number | null => {
    const r = viewport.current?.getBoundingClientRect();
    if (!r || r.width === 0) return null;
    return v.start + ((clientX - r.left) / r.width) * (v.end - v.start);
  };

  // Ctrl+scroll (and a trackpad pinch) zooms at the cursor; a sideways scroll pans.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      const v = live.current.view;
      const sp = live.current.span;
      const w = v.end - v.start;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      if (e.ctrlKey) {
        e.preventDefault();
        const at = timeAt(e.clientX, v) ?? (v.start + v.end) / 2;
        const f = Math.exp(e.deltaY * unit * 0.01);
        setViewState(clampView({ start: at - (at - v.start) * f, end: at + (v.end - at) * f }, sp));
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && w < sp.end - sp.start) {
        e.preventDefault();
        const shift = ((e.deltaX * unit) / Math.max(1, el.clientWidth)) * w;
        setViewState(clampView({ start: v.start + shift, end: v.end + shift }, sp));
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (segs.length === 0) return null;

  const vw = Math.max(1, view.end - view.start);
  const pct = (t: number) => ((t - view.start) / vw) * 100;
  const toPx = (t: number) => (pct(t) / 100) * px;
  const zoomed = vw < span.end - span.start;
  const len = (s: Segment) => formatSeconds(Math.round((s.end - s.start) / 1000));
  const textOf = (s: Segment) => s.locked ?? s.text.trim();

  // ── taps, pans and pinches on the bar ──
  const tap = (clientX: number) => {
    const t = timeAt(clientX);
    if (t === null) return;
    const st = g.current;
    const now = Date.now();
    const last = st.lastTap;
    if (last && now - last.at <= DOUBLE_TAP_MS && Math.abs(clientX - last.x) <= DOUBLE_TAP_PX) {
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
      st.lastTap = null;
      const next = cutAt(segs, t);
      if (next) onChange(next, -1);
      return;
    }
    st.lastTap = { at: now, x: clientX };
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      st.timer = null;
      const { segs: now, onSelect: pick } = live.current;
      const i = pieceAt(now, t);
      if (i !== -1 && now[i]!.locked === null) pick(i);
    }, DOUBLE_TAP_MS);
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if ((e.target as Element).closest?.(".piece-input")) return; // typing, not a gesture
    e.preventDefault(); // keep the text box (and the phone keyboard) focused
    const st = g.current;
    st.pointers.set(e.pointerId, e.clientX);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events in tests have no active pointer
    }
    if (st.pointers.size === 1) {
      st.press = { x: e.clientX, moved: false };
      st.pan = { x: e.clientX, view };
      st.pinch = null;
    } else if (st.pointers.size === 2) {
      const [x1, x2] = [...st.pointers.values()] as [number, number];
      const t1 = timeAt(x1);
      const t2 = timeAt(x2);
      st.pinch = t1 !== null && t2 !== null ? { t1, t2 } : null;
      st.press = null;
      st.pan = null;
    }
  };

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const st = g.current;
    if (!st.pointers.has(e.pointerId)) return;
    st.pointers.set(e.pointerId, e.clientX);
    if (st.pinch && st.pointers.size >= 2) {
      const [x1, x2] = [...st.pointers.values()] as [number, number];
      const r = viewport.current?.getBoundingClientRect();
      if (!r || Math.abs(x2 - x1) < 12) return;
      // Keep the two times that were under the fingers under the fingers.
      const msPerPx = (st.pinch.t2 - st.pinch.t1) / (x2 - x1);
      if (msPerPx <= 0) return;
      const start = st.pinch.t1 - (x1 - r.left) * msPerPx;
      setView({ start, end: start + r.width * msPerPx });
      return;
    }
    if (st.pan && st.press) {
      const dx = e.clientX - st.pan.x;
      if (!st.press.moved && Math.abs(dx) < TAP_SLOP) return;
      st.press.moved = true;
      const w = st.pan.view.end - st.pan.view.start;
      const shift = (-dx / Math.max(1, px)) * w;
      setView({ start: st.pan.view.start + shift, end: st.pan.view.end + shift });
    }
  };

  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const st = g.current;
    if (!st.pointers.has(e.pointerId)) return;
    const wasTap = e.type === "pointerup" && st.pointers.size === 1 && st.press !== null && !st.press.moved;
    st.pointers.delete(e.pointerId);
    if (wasTap) tap(e.clientX);
    if (st.pointers.size === 1) {
      // One finger of a pinch lifted: carry on panning with the other.
      const x = [...st.pointers.values()][0]!;
      st.press = { x, moved: true };
      st.pan = { x, view: live.current.view };
      st.pinch = null;
    } else if (st.pointers.size === 0) {
      st.press = null;
      st.pan = null;
      st.pinch = null;
    }
  };

  // ── dividers ──
  const selectedAfterMerge = (i: number) => (selected === -1 ? -1 : selected <= i ? selected : selected === i + 1 ? i : selected - 1);

  const merge = (i: number, keep: "left" | "right") => {
    const next = mergeCut(segs, i, keep);
    if (next) onChange(next, selectedAfterMerge(i));
  };

  const onHandleDown = (i: number) => (e: PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events in tests have no active pointer
    }
    setDrag({ i, merge: null });
  };

  const onHandleMove = (i: number) => (e: PointerEvent<HTMLButtonElement>) => {
    if (!drag || drag.i !== i) return;
    e.stopPropagation();
    const t = timeAt(e.clientX);
    const a = segs[i];
    const b = segs[i + 1];
    if (t === null || !a || !b) return;
    const shown = viewport.current?.getBoundingClientRect().width || px;
    const near = Math.max(MIN_PIECE_MS, shown > 0 ? (MERGE_PX / shown) * vw : 0);
    const m = t <= a.start + near ? "left" : t >= b.end - near ? "right" : null;
    if (m === null) {
      const next = moveCut(segs, i, t);
      if (next) onChange(next);
    }
    if (m !== drag.merge) setDrag({ i, merge: m });
  };

  const onHandleUp = (i: number) => (e: PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    // Dragged into the left piece: it is the one kept (its label); into the right: that one.
    if (drag?.i === i && drag.merge && e.type === "pointerup") merge(i, drag.merge);
    setDrag(null);
  };

  const onHandleKey = (i: number) => (e: KeyboardEvent) => {
    const cut = segs[i]!.end;
    const step = (e.shiftKey ? 15 : 1) * MINUTE;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      const next = moveCut(segs, i, cut - step);
      if (next) onChange(next);
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      const next = moveCut(segs, i, cut + step);
      if (next) onChange(next);
    } else if (e.key === "Delete" || e.key === "Backspace") merge(i, "left");
    else return;
    e.preventDefault();
  };

  const onPieceKey = (i: number) => (e: KeyboardEvent) => {
    const s = segs[i]!;
    if (s.locked !== null) return;
    if (e.key === "/") {
      e.preventDefault();
      const next = splitAt(segs, i, (s.start + s.end) / 2);
      if (next) onChange(next, -1);
    }
  };

  // ── what is drawn ──
  const visible = (s: Segment) => s.end > view.start && s.start < view.end;
  const cuts = segs.slice(0, -1).map((s, i) => ({ i, t: s.end }));
  const cutLabels: { i: number; t: number; row: number }[] = [];
  const lastX = [-Infinity, -Infinity];
  for (const c of cuts) {
    if (c.t < view.start || c.t > view.end) continue;
    const x = toPx(c.t);
    const row = x - lastX[0]! >= CUT_LABEL_PX ? 0 : x - lastX[1]! >= CUT_LABEL_PX ? 1 : lastX[0]! <= lastX[1]! ? 0 : 1;
    lastX[row] = x;
    cutLabels.push({ ...c, row });
  }
  const ticks = tickTimes(view, px);

  const picked = segs[selected]?.locked === null ? segs[selected] : undefined;
  let editor: { inline: boolean; left: number; width: number } | null = null;
  if (picked && visible(picked)) {
    const lo = Math.max(picked.start, view.start);
    const hi = Math.min(picked.end, view.end);
    const room = toPx(hi) - toPx(lo);
    const need = Math.max(96, picked.text.length * 8.5 + 28);
    if (px > 0 && room >= need) editor = { inline: true, left: toPx(lo), width: room };
    else {
      const width = Math.min(px > 0 ? px : 240, 240);
      const centre = (toPx(lo) + toPx(hi)) / 2;
      editor = { inline: false, left: Math.min(Math.max(0, centre - width / 2), Math.max(0, px - width)), width };
    }
  }

  const dragged = drag ? segs[drag.i] : undefined;
  const draggedNext = drag ? segs[drag.i + 1] : undefined;

  return (
    <div className="splitbar" role="group" aria-label={label}>
      <div className="splitbar-cuts" aria-hidden="true">
        {cutLabels.map((c) => (
          <span key={c.i} className={`split-cut-time row${c.row}`} style={{ left: `${pct(c.t)}%` }}>
            {clock(c.t)}
          </span>
        ))}
      </div>
      <div className="splitbar-body">
        <div
          className={`splitbar-viewport ${zoomed ? "zoomed" : ""}`}
          ref={viewport}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          {segs.map((s, i) => {
            if (!visible(s)) return null;
            const hue = s.locked === null && !s.text.trim() ? null : hueOf(s);
            const kind = s.locked !== null ? "locked" : s.text.trim() ? "labeled" : "unlogged";
            const w = toPx(Math.min(s.end, view.end)) - toPx(Math.max(s.start, view.start));
            const showText = px === 0 || w >= 28;
            return (
              <button
                key={`${s.start}-${i}`}
                type="button"
                className={`split-piece ${kind} ${hue === null ? "neutral" : ""} ${i === selected ? "selected" : ""}`}
                style={{ left: `${pct(s.start)}%`, width: `${pct(s.end) - pct(s.start)}%`, "--hue": hue ?? 0 } as CSSProperties}
                aria-disabled={s.locked !== null}
                aria-pressed={s.locked === null ? i === selected : undefined}
                aria-label={`${clock(s.start)} to ${clock(s.end)}, ${len(s)}: ${textOf(s) || "unlogged"}`}
                onClick={(e) => e.detail === 0 && s.locked === null && onSelect(i)}
                onKeyDown={onPieceKey(i)}
              >
                {showText && !(i === selected && editor?.inline) && (
                  <span className="split-piece-text">{textOf(s)}</span>
                )}
              </button>
            );
          })}
          {cuts.map(({ i, t }) =>
            isMovableCut(segs, i) && t >= view.start && t <= view.end ? (
              <button
                key={`cut-${i}`}
                type="button"
                className={`split-handle ${drag?.i === i ? "dragging" : ""}`}
                style={{ left: `${pct(t)}%` }}
                aria-label={`Divider at ${clock(t)}: drag or arrows move it, onto a neighbour or Delete merges`}
                onPointerDown={onHandleDown(i)}
                onPointerMove={onHandleMove(i)}
                onPointerUp={onHandleUp(i)}
                onPointerCancel={onHandleUp(i)}
                onKeyDown={onHandleKey(i)}
              />
            ) : null,
          )}
          {picked && editor?.inline && (
            <input
              ref={input.ref}
              className="piece-input inline"
              style={{ left: editor.left, width: editor.width, "--hue": hueOf(picked) ?? 0 } as CSSProperties}
              aria-label={input.label(picked)}
              placeholder="Type…"
              maxLength={input.maxLength}
              value={picked.text}
              onChange={(e) => input.onText(e.target.value)}
              onKeyDown={input.onKeyDown}
            />
          )}
        </div>
        {picked && editor && !editor.inline && (
          <input
            ref={input.ref}
            className="piece-input floating"
            style={{ left: editor.left, width: editor.width }}
            aria-label={input.label(picked)}
            placeholder={input.placeholder}
            maxLength={input.maxLength}
            value={picked.text}
            onChange={(e) => input.onText(e.target.value)}
            onKeyDown={input.onKeyDown}
          />
        )}
        {drag && dragged && draggedNext && (
          <div className="split-drag-tip" role="status" style={{ left: `${Math.min(100, Math.max(0, pct(dragged.end)))}%` }}>
            {drag.merge ? (
              "Release to merge"
            ) : (
              <>
                <strong>{clock(dragged.end)}</strong>
                <span>
                  ← {len(dragged)} · {len(draggedNext)} →
                </span>
              </>
            )}
          </div>
        )}
      </div>
      <div className="splitbar-scale" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t} style={{ left: `${pct(t)}%` }}>
            {clock(t)}
          </span>
        ))}
      </div>
      <p className="splitbar-hint muted">
        Double-tap to cut · drag a line to move it, onto a neighbour to merge · pinch to zoom
        {zoomed && (
          <button type="button" className="ghost small" onClick={() => setViewState({ ...span })}>
            Show all
          </button>
        )}
      </p>
    </div>
  );
}
