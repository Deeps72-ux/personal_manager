/**
 * A "day" is a plain calendar date string: "2026-11-05".
 * No time, no timezone: Nov 5 is Nov 5 on every device, in every country.
 */
export type Day = string;

export const DAY_SECONDS = 24 * 60 * 60; // 86,400

const DAY_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Strict check, including month lengths and leap years (rejects 2026-02-29). */
export function isValidDay(value: string): boolean {
  const m = DAY_FORMAT.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month = last day of this month (UTC avoids DST quirks).
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Today's date in the device's local timezone. */
export function todayLocal(now: Date = new Date()): Day {
  const y = String(now.getFullYear()).padStart(4, "0");
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** One day's share of a time span. */
export interface DayPart {
  day: Day;
  seconds: number;
}

/**
 * Cut the span [startMs, endMs) at each LOCAL midnight: one part per day,
 * oldest first. Works for any number of days. Parts under 1 s are dropped,
 * and a part never exceeds DAY_SECONDS (a 25-hour clock-change day is capped).
 */
export function splitByDay(startMs: number, endMs: number): DayPart[] {
  const parts: DayPart[] = [];
  let from = startMs;
  while (from < endMs) {
    const d = new Date(from);
    const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const to = Math.min(nextMidnight, endMs);
    const seconds = Math.min(DAY_SECONDS, Math.floor((to - from) / 1000));
    if (seconds >= 1) parts.push({ day: todayLocal(d), seconds });
    from = to;
  }
  return parts;
}
