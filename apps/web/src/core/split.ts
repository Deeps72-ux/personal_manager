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
 * least 1 minute long.
 */
import { activityKey, dayBounds, parseActivity, type Day, type Interval } from "@pm/shared";
import type { DayLayout } from "./timeline.ts";

export const MIN_PIECE_MS = 60_000;
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
      ...(layout.timer && b === layout.timer ? ["Timer running"] : []),
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

/** Cut open piece `i` in its middle. */
export const splitMiddle = (segs: readonly Segment[], i: number): Segment[] | null =>
  segs[i] ? splitAt(segs, i, (segs[i]!.start + segs[i]!.end) / 2) : null;

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

/** Remove the cut between pieces `i` and `i + 1`: one piece, keeping the left label (else the right one). */
export function removeCut(segs: readonly Segment[], i: number): Segment[] | null {
  if (!isMovableCut(segs, i)) return null;
  const a = segs[i]!;
  const b = segs[i + 1]!;
  return [...segs.slice(0, i), { ...a, end: b.end, text: a.text.trim() ? a.text : b.text }, ...segs.slice(i + 2)];
}

/**
 * Pick exactly [from, to) inside open piece `i` (both snapped to whole
 * minutes, clamped to the piece): it becomes its own piece, keeping the
 * label; what is left on either side becomes unlogged. Returns the new
 * pieces and the index of the picked one, or null.
 */
export function carve(
  segs: readonly Segment[],
  i: number,
  from: number,
  to: number,
): { segs: Segment[]; index: number } | null {
  const s = segs[i];
  if (!isOpen(s)) return null;
  const lo = Math.max(s.start, from <= s.start ? s.start : roundMin(from));
  const hi = Math.min(s.end, to >= s.end ? s.end : roundMin(to));
  if (hi - lo < Math.min(MIN_PIECE_MS, s.end - s.start)) return null;
  const parts: Segment[] = [];
  if (lo > s.start) parts.push({ start: s.start, end: lo, locked: null, text: "" });
  const index = i + parts.length;
  parts.push({ start: lo, end: hi, locked: null, text: s.text });
  if (hi < s.end) parts.push({ start: hi, end: s.end, locked: null, text: "" });
  return { segs: [...segs.slice(0, i), ...parts, ...segs.slice(i + 1)], index };
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

/**
 * The moment in [lo, hi] that reads `hhmm` ("HH:MM") on the local clock,
 * the first one if the span holds several; null if none or malformed.
 */
export function resolveClock(hhmm: string, lo: number, hi: number): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  if (h > 23 || min > 59) return null;
  const base = new Date(lo);
  for (let d = 0; d < 3; d++) {
    const t = new Date(base.getFullYear(), base.getMonth(), base.getDate() + d, h, min).getTime();
    if (t > hi) break;
    if (t >= floorMin(lo)) return Math.max(t, lo);
  }
  return null;
}

const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/**
 * `carve` from typed clock times ("HH:MM"). A time left as the piece shows
 * it keeps the piece's exact edge (so 00:00 at the end of a day stays the
 * end of the day).
 */
export function carveByClock(
  segs: readonly Segment[],
  i: number,
  fromText: string,
  toText: string,
): { segs: Segment[]; index: number } | null {
  const s = segs[i];
  if (!isOpen(s)) return null;
  const from = fromText === hhmm(s.start) ? s.start : resolveClock(fromText, s.start, s.end);
  if (from === null) return null;
  const to = toText === hhmm(s.end) ? s.end : resolveClock(toText, from + 1, s.end);
  if (to === null) return null;
  return carve(segs, i, from, to);
}
