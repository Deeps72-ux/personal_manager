import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { formatSeconds } from "@pm/shared";
import { isMovableCut, moveCut, removeCut, type Segment } from "../core/split.ts";
import { pad2 } from "../core/views.ts";

const clock = (t: number) => {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const MINUTE = 60_000;

/**
 * SPLIT BAR: a span of time as pieces side by side. Tap a piece to pick it;
 * drag a divider (or focus it and use ←/→, Shift for 15 min) to move it,
 * Delete removes it. Locked pieces (time already taken) are hatched and
 * cannot be picked. Under the bar: every piece as a row, so each is easy to
 * pick on a phone too.
 */
export function SplitBar({
  segs,
  selected,
  onSelect,
  onChange,
  label,
}: {
  segs: readonly Segment[];
  selected: number;
  onSelect: (i: number) => void;
  /** New pieces, and the piece to pick if it changes. */
  onChange: (segs: Segment[], selected?: number) => void;
  label: string;
}) {
  const bar = useRef<HTMLDivElement>(null);
  if (segs.length === 0) return null;
  const start = segs[0]!.start;
  const end = segs.at(-1)!.end;
  const width = Math.max(1, end - start);
  const pct = (t: number) => ((t - start) / width) * 100;

  const timeAt = (clientX: number) => {
    const r = bar.current?.getBoundingClientRect();
    if (!r || r.width === 0) return null;
    return start + ((clientX - r.left) / r.width) * width;
  };

  const move = (i: number, to: number) => {
    const next = moveCut(segs, i, to);
    if (next) onChange(next);
  };

  const onHandleKey = (i: number) => (e: KeyboardEvent) => {
    const cut = segs[i]!.end;
    const step = (e.shiftKey ? 15 : 1) * MINUTE;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") move(i, cut - step);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") move(i, cut + step);
    else if (e.key === "Delete" || e.key === "Backspace") {
      const next = removeCut(segs, i);
      if (next) onChange(next, i);
    } else return;
    e.preventDefault();
  };

  const onHandleDown = (i: number) => (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHandleMove = (i: number) => (e: PointerEvent<HTMLButtonElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const t = timeAt(e.clientX);
    if (t !== null) move(i, t);
  };

  return (
    <div className="splitbar" role="group" aria-label={label}>
      <div className="splitbar-track" ref={bar}>
        {segs.map((s, i) => (
          <button
            key={`${s.start}-${i}`}
            type="button"
            className={`split-piece ${s.locked !== null ? "locked" : s.text.trim() ? "labeled" : "unlogged"} ${i === selected ? "selected" : ""}`}
            style={{ left: `${pct(s.start)}%`, width: `${pct(s.end) - pct(s.start)}%` } as CSSProperties}
            disabled={s.locked !== null}
            tabIndex={-1}
            aria-hidden="true"
            title={`${clock(s.start)} – ${clock(s.end)} · ${s.locked ?? (s.text.trim() || "unlogged")}`}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => onSelect(i)}
          />
        ))}
        {segs.slice(0, -1).map((s, i) =>
          isMovableCut(segs, i) ? (
            <button
              key={`cut-${i}`}
              type="button"
              className="split-handle"
              style={{ left: `${pct(s.end)}%` }}
              aria-label={`Divider at ${clock(s.end)}: arrows move it, Delete removes it`}
              onPointerDown={onHandleDown(i)}
              onPointerMove={onHandleMove(i)}
              onKeyDown={onHandleKey(i)}
            />
          ) : null,
        )}
      </div>
      <div className="splitbar-scale" aria-hidden="true">
        <span>{clock(start)}</span>
        <span>{clock(end)}</span>
      </div>
      <ol className="split-list">
        {segs.map((s, i) => (
          <li key={`${s.start}-${i}`}>
            <button
              type="button"
              className={`split-row ${s.locked !== null ? "locked" : s.text.trim() ? "labeled" : "unlogged"} ${i === selected ? "selected" : ""}`}
              disabled={s.locked !== null}
              aria-pressed={s.locked === null ? i === selected : undefined}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => onSelect(i)}
            >
              <span className="split-row-time">
                {clock(s.start)}–{clock(s.end)}
              </span>
              <span className="split-row-label">{s.locked ?? (s.text.trim() || "unlogged")}</span>
              <span className="split-row-len muted">{formatSeconds(Math.round((s.end - s.start) / 1000))}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** From / To of the picked piece (whole minutes) and ✂ split it in two. */
export function PieceRange({
  seg,
  onRange,
  onSplit,
  canSplit,
}: {
  seg: Segment;
  onRange: (from: string, to: string) => void;
  onSplit: () => void;
  canSplit: boolean;
}) {
  return (
    <div className="piece-range">
      <label>
        From
        <input type="time" step={60} value={clock(seg.start)} onChange={(e) => onRange(e.target.value, clock(seg.end))} />
      </label>
      <label>
        To
        <input type="time" step={60} value={clock(seg.end)} onChange={(e) => onRange(clock(seg.start), e.target.value)} />
      </label>
      <button type="button" className="ghost small" onClick={onSplit} disabled={!canSplit}>
        ✂ Split
      </button>
    </div>
  );
}
