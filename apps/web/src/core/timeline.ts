/**
 * Logs on the clock: where each log sits in its day, the free time left for
 * manual logs, overlapping logs to resolve, and FOCUS per clock hour.
 * Pure functions: no storage, no React.
 */
import {
  activityKey,
  dayBounds,
  hourFocus,
  logSpan,
  mergeIntervals,
  overlaps,
  subtractIntervals,
  uuidv7Time,
  type Day,
  type Interval,
  type LogEntry,
  type LogSource,
} from "@pm/shared";

/**
 * Where a log sits on the clock, if known: its own start, or, for TIMER logs
 * from before logs had a start, worked out from when ✓ was pressed (the id
 * time) and the day it belongs to. Older manual logs have no known time.
 */
export function knownSpan(e: LogEntry): Interval | null {
  if (e.startMs !== null && e.startMs !== undefined) return logSpan(e.startMs, e.seconds);
  if (e.focus === null || e.focus === undefined) return null;
  const day = dayBounds(e.day);
  const end = Math.min(uuidv7Time(e.id), day.end);
  if (end <= day.start) return null;
  return { start: Math.max(day.start, end - e.seconds * 1000), end };
}

/** "timer" / "manual"; older logs: scored ones came from the timer. */
export const logKind = (e: LogEntry): LogSource =>
  e.source ?? (e.focus !== null && e.focus !== undefined ? "timer" : "manual");

export interface Piece extends Interval {
  entry: LogEntry;
  /** false: an older manual log with no time, packed into the earliest free time. */
  exact: boolean;
}

export interface DayLayout {
  bounds: Interval;
  pieces: Piece[];
  /** The running TIMER's part of this day, if any: [timer start, end of day). */
  timer: Interval | null;
  busy: Interval[];
  free: Interval[];
}

/**
 * Lay out one day: logs with a known time where they are, the running TIMER
 * from its start on (it will log that time), then older untimed manual logs
 * packed into the earliest free gaps from midnight (split if they must be).
 */
export function dayLayout(day: Day, entries: readonly LogEntry[], timerStart: number | null): DayLayout {
  const bounds = dayBounds(day);
  const pieces: Piece[] = [];
  const untimed: LogEntry[] = [];
  for (const e of entries) {
    const span = knownSpan(e);
    if (span) pieces.push({ ...span, entry: e, exact: true });
    else untimed.push(e);
  }
  const timer =
    timerStart !== null && timerStart < bounds.end ? { start: Math.max(bounds.start, timerStart), end: bounds.end } : null;

  let free = subtractIntervals(bounds, [...pieces, ...(timer ? [timer] : [])]);
  for (const e of [...untimed].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    let need = e.seconds * 1000;
    const rest: Interval[] = [];
    for (const g of free) {
      if (need <= 0) {
        rest.push(g);
        continue;
      }
      const take = Math.min(need, g.end - g.start);
      pieces.push({ start: g.start, end: g.start + take, entry: e, exact: false });
      need -= take;
      if (g.start + take < g.end) rest.push({ start: g.start + take, end: g.end });
    }
    free = rest;
  }
  pieces.sort((a, b) => a.start - b.start || a.end - b.end);
  return { bounds, pieces, timer, busy: mergeIntervals([...pieces, ...(timer ? [timer] : [])]), free };
}

/** Start of the earliest free gap that holds `seconds` whole, else null. */
export function firstFit(free: readonly Interval[], seconds: number): number | null {
  return free.find((g) => g.end - g.start >= seconds * 1000)?.start ?? null;
}

/** Longest free gap, in whole seconds. */
export const longestGap = (free: readonly Interval[]): number =>
  free.reduce((m, g) => Math.max(m, Math.floor((g.end - g.start) / 1000)), 0);

/** True if [start, end) lies inside one free gap. */
export const fitsInFree = (free: readonly Interval[], span: Interval): boolean =>
  free.some((g) => g.start <= span.start && span.end <= g.end);

export interface Conflict {
  a: LogEntry;
  b: LogEntry;
  aSpan: Interval;
  bSpan: Interval;
}

/**
 * Logs of the SAME kind that overlap (two timers, or two manual logs, made on
 * devices that were apart). The user keeps one. A timer log over a manual one
 * is no conflict: the server trims the manual log.
 */
export function findConflicts(entries: readonly LogEntry[]): Conflict[] {
  const timed = entries
    .map((e) => ({ e, span: knownSpan(e), kind: logKind(e) }))
    .filter((x): x is { e: LogEntry; span: Interval; kind: LogSource } => x.span !== null)
    .sort((x, y) => x.span.start - y.span.start);
  const out: Conflict[] = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length && timed[j]!.span.start < timed[i]!.span.end; j++) {
      const [x, y] = [timed[i]!, timed[j]!];
      if (x.kind === y.kind && overlaps(x.span, y.span)) out.push({ a: x.e, b: y.e, aSpan: x.span, bSpan: y.span });
    }
  }
  return out;
}

const HOUR = 3_600_000;

/** Local start of the clock hour containing `t`. */
export function hourStart(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
}
const nextHour = (h: number) => {
  const d = new Date(h);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
};

export interface HourFocus {
  /** Start of the clock hour. */
  hour: number;
  /** End of what was scored: the hour's end, or earlier if it is still running. */
  end: number;
  switches: number;
  focus: number;
  /** Seconds logged in the scored part of the hour. */
  seconds: number;
}

/**
 * FOCUS per clock hour = 100 / (1 + switches). Walking the hour, a switch is
 * every change from one activity to another, and an empty stretch counts as
 * an activity of its own (A, gap, B = 2 switches). Time from the running
 * TIMER's start, and the future, is not scored yet. Only hours with at least
 * one log of known time get a score.
 */
export function hourlyFocus(
  entries: readonly LogEntry[],
  timerStart: number | null,
  now: number,
): HourFocus[] {
  const byDay = new Map<Day, LogEntry[]>();
  for (const e of entries) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
  const pieces = [...byDay].flatMap(([day, list]) => dayLayout(day, list, timerStart).pieces);
  pieces.sort((a, b) => a.start - b.start);

  const hours = new Set<number>();
  for (const p of pieces) {
    if (!p.exact) continue;
    for (let h = hourStart(p.start); h < p.end; h = nextHour(h)) hours.add(h);
  }
  const limit = Math.min(now, timerStart ?? Infinity);

  const out: HourFocus[] = [];
  for (const hour of [...hours].sort((a, b) => a - b)) {
    const end = Math.min(nextHour(hour), limit);
    if (end <= hour) continue;
    const inside = pieces
      .filter((p) => p.start < end && p.end > hour)
      .map((p) => ({ start: Math.max(p.start, hour), end: Math.min(p.end, end), key: activityKey(p.entry.taskTitle), exact: p.exact }));
    if (!inside.some((p) => p.exact)) continue;
    const labels: string[] = [];
    const push = (label: string) => labels.at(-1) !== label && labels.push(label);
    let cursor = hour;
    let seconds = 0;
    for (const p of inside) {
      if (p.start > cursor) push("\u0000gap");
      push(p.key);
      seconds += (p.end - p.start) / 1000;
      cursor = Math.max(cursor, p.end);
    }
    if (cursor < end) push("\u0000gap");
    const switches = labels.length - 1;
    out.push({ hour, end, switches, focus: hourFocus(switches), seconds: Math.round(seconds) });
  }
  return out;
}

export const HOUR_MS = HOUR;
