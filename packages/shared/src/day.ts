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
