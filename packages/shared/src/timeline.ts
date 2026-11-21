/**
 * Half-open time intervals [start, end) in epoch ms. Pure helpers shared by
 * the server (trimming manual logs under timer logs) and the devices
 * (finding free time, conflicts, hourly focus).
 */
export interface Interval {
  start: number;
  end: number;
}

export const overlaps = (a: Interval, b: Interval): boolean => a.start < b.end && b.start < a.end;

/** Sorted, merged copy (touching intervals are merged too). */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out.at(-1);
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/** What is left of `base` after removing every interval in `cut`, in order. */
export function subtractIntervals(base: Interval, cut: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let from = base.start;
  for (const c of mergeIntervals(cut)) {
    if (c.end <= from) continue;
    if (c.start >= base.end) break;
    if (c.start > from) out.push({ start: from, end: Math.min(c.start, base.end) });
    from = Math.max(from, c.end);
    if (from >= base.end) break;
  }
  if (from < base.end) out.push({ start: from, end: base.end });
  return out;
}

/** Interval of a timed log: [startMs, startMs + seconds·1000). */
export const logSpan = (startMs: number, seconds: number): Interval => ({ start: startMs, end: startMs + seconds * 1000 });
