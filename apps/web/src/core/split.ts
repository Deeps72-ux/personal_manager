/**
 * SPLIT BAR: a span of time cut into pieces the user labels one by one.
 * Used by the TIMER (from the last restart until now) and by a LOG day
 * (its 24 hours). Pure functions: no storage, no React.
 *
 * The pieces always cover the span exactly, in order. A LOCKED piece is time
 * that is already taken (a log, the running timer): it cannot be cut, moved
 * or labeled. An open piece with empty `text` is UNLOGGED.
 *
 * Cuts made by the user sit on whole clock minutes and leave every piece at
 * least 1 minute long. A cut is made at a moment (double-tap), moved by
 * dragging its divider, and removed by dragging it onto a neighbour.
 */
import { activityKey, dayBounds, parseActivity, type Day, type Interval } from "@pm/shared";
import type { DayLayout } from "./timeline.ts";

export const MIN_PIECE_MS = 60_000;
/** What locked time held by the running TIMER is labeled. */
export const TIMER_LABEL = "Timer running";
const MINUTE = 60_000;

export interface Segment {
  start: number;
  end: number;
  /** Null: open. Otherwise what holds this time (shown, never edited). */
  locked: string | null;
  /** The activity typed for this piece; "" = unlogged. */
  text: string;
}

const isOpen = (s: Segment | undefined): s is Segment => s !== undefined && s.locked === null;
const ceilMin = (t: number) => Math.ceil(t / MINUTE) * MINUTE;
const floorMin = (t: number) => Math.floor(t / MINUTE) * MINUTE;
const roundMin = (t: number) => Math.round(t / MINUTE) * MINUTE;

/** The nearest whole minute to `t` that leaves at least 1 minute on each side within [lo, hi]; null if none. */
function snapBetween(t: number, lo: number, hi: number): number | null {
  const min = ceilMin(lo + MIN_PIECE_MS);
  const max = floorMin(hi - MIN_PIECE_MS);
  if (min > max) return null;
  return Math.min(max, Math.max(min, roundMin(t)));
}

/** One open, unlogged piece over [start, end) (e.g. the TIMER's span), with `text` if given. */
export const singleSegment = (start: number, end: number, text = ""): Segment[] => [{ start, end, locked: null, text }];

/**
 * A LOG day as pieces: time already taken (logs, the running timer) is
 * locked, labeled with what is there; free time is open and unlogged.
 */
export function daySegments(day: Day, layout: Pick<DayLayout, "pieces" | "timer" | "free">): Segment[] {
  const bounds = dayBounds(day);
  const busy: Interval[] = layout.pieces.map((p) => ({ start: p.start, end: p.end }));
  if (layout.timer) busy.push(layout.timer);
  const out: Segment[] = layout.free.map((g) => ({ start: g.start, end: g.end, locked: null, text: "" }));
  // Busy time, merged, labeled with every title in it.
  const sorted = [...busy].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number; labels: string[] }[] = [];
  for (const b of sorted) {
    const labels = [
      ...layout.pieces.filter((p) => p.start === b.start && p.end === b.end).map((p) => p.entry.taskTitle),
      ...(layout.timer && b === layout.timer ? [TIMER_LABEL] : []),
    ];
    const last = merged.at(-1);
    if (last && b.start <= last.end) {
      last.end = Math.max(last.end, b.end);
      for (const l of labels) if (!last.labels.includes(l)) last.labels.push(l);
    } else merged.push({ start: b.start, end: b.end, labels });
  }
  for (const m of merged) {
    const start = Math.max(m.start, bounds.start);
    const end = Math.min(m.end, bounds.end);
    if (end > start) out.push({ start, end, locked: m.labels.join(" / ") || "Taken", text: "" });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Cut open piece `i` at `at` (snapped to a whole minute). The new right part is unlogged. Null if it cannot be cut there. */
export function splitAt(segs: readonly Segment[], i: number, at: number): Segment[] | null {
  const s = segs[i];
  if (!isOpen(s)) return null;
  const cut = snapBetween(at, s.start, s.end);
  if (cut === null) return null;
  return [...segs.slice(0, i), { ...s, end: cut }, { start: cut, end: s.end, locked: null, text: "" }, ...segs.slice(i + 1)];
}

/** The piece holding moment `t` (its start included), or -1. */
export const pieceAt = (segs: readonly Segment[], t: number): number =>
  segs.findIndex((s, k) => s.start <= t && (t < s.end || (k === segs.length - 1 && t <= s.end)));

/**
 * Cut the open piece under moment `t` there, snapped to a whole minute. A cut
 * closer than 1 minute to a divider or an edge is nudged 1 minute away from
 * it. Null if `t` is on locked time or the piece is shorter than 2 minutes.
 */
export function cutAt(segs: readonly Segment[], t: number): Segment[] | null {
  const i = pieceAt(segs, t);
  return i === -1 ? null : splitAt(segs, i, t);
}

/** True if the cut between `i` and `i + 1` can be moved or removed (both sides open). */
export const isMovableCut = (segs: readonly Segment[], i: number): boolean => isOpen(segs[i]) && isOpen(segs[i + 1]);

/** Move the cut between pieces `i` and `i + 1` to `to` (snapped, keeping both at least 1 minute). */
export function moveCut(segs: readonly Segment[], i: number, to: number): Segment[] | null {
  if (!isMovableCut(segs, i)) return null;
  const a = segs[i]!;
  const b = segs[i + 1]!;
  const cut = snapBetween(to, a.start, b.end);
  if (cut === null) return null;
  return [...segs.slice(0, i), { ...a, end: cut }, { ...b, start: cut }, ...segs.slice(i + 2)];
}

/**
 * Remove the cut between pieces `i` and `i + 1`: one piece. It keeps the
 * label of the side named by `keep` (the piece the divider was dragged
 * into), or the other side's if that one is unlogged.
 */
export function mergeCut(segs: readonly Segment[], i: number, keep: "left" | "right" = "left"): Segment[] | null {
  if (!isMovableCut(segs, i)) return null;
  const a = segs[i]!;
  const b = segs[i + 1]!;
  const [first, second] = keep === "left" ? [a.text, b.text] : [b.text, a.text];
  return [...segs.slice(0, i), { ...a, end: b.end, text: first.trim() ? first : second }, ...segs.slice(i + 2)];
}

/** Set the label of open piece `i`. */
export function setText(segs: readonly Segment[], i: number, text: string): Segment[] {
  if (!isOpen(segs[i])) return [...segs];
  return segs.map((s, k) => (k === i ? { ...s, text } : s));
}

export interface LoggedPiece {
  startMs: number;
  endMs: number;
  activity: string;
}

export type PiecesResult = { ok: true; pieces: LoggedPiece[] } | { ok: false; error: string; index: number };

/**
 * What will be logged: every open, labeled piece, its label checked as ONE
 * activity. Neighbouring pieces with the same activity become one (they
 * may be entered separately). Unlogged and locked pieces are skipped.
 */
export function piecesToLog(segs: readonly Segment[], knownTitles: readonly string[] = []): PiecesResult {
  const out: LoggedPiece[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (s.locked !== null || !s.text.trim()) continue;
    const a = parseActivity(s.text, knownTitles);
    if (!a.ok) return { ok: false, error: a.error, index: i };
    const last = out.at(-1);
    if (last && last.endMs === s.start && activityKey(last.activity) === activityKey(a.activity)) last.endMs = s.end;
    else out.push({ startMs: s.start, endMs: s.end, activity: a.activity });
  }
  return { ok: true, pieces: out };
}

/** The open piece containing `t`, else the first open piece, else -1. */
export function openIndexAt(segs: readonly Segment[], t: number): number {
  const at = segs.findIndex((s) => s.locked === null && s.start <= t && t < s.end);
  return at !== -1 ? at : segs.findIndex((s) => s.locked === null);
}
