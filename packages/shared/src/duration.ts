/**
 * Seconds input for the LOG day sheet.
 *
 * Accepted forms (whitespace ignored):
 *   "27"            plain seconds
 *   "8*60*60"       product of integers ("x" and "×" also work)
 *   "8h", "90m", "45s", "1h30m", "1h 30m 15s"   unit form
 *
 * Never uses eval. Result is always an integer in 1..86,400.
 */
import { DAY_SECONDS } from "./day.ts";

export type ParseResult = { ok: true; seconds: number } | { ok: false; error: string };

const INTEGER = /^\d+$/;
const PRODUCT = /^\d+(?:[*x×]\d+)+$/i;
const UNITS = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i;

export function parseSecondsInput(input: string): ParseResult {
  const s = input.replace(/\s+/g, "");
  if (s === "") return { ok: false, error: "Enter a number of seconds" };

  let seconds: number;
  if (INTEGER.test(s)) {
    seconds = Number(s);
  } else if (PRODUCT.test(s)) {
    seconds = s.split(/[*x×]/i).reduce((acc, n) => acc * Number(n), 1);
  } else {
    const m = UNITS.exec(s);
    if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) {
      return { ok: false, error: 'Use seconds like "27", "8*60*60" or "1h30m"' };
    }
    seconds = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  }

  if (!Number.isSafeInteger(seconds) || seconds > DAY_SECONDS) {
    return { ok: false, error: `Cannot exceed ${DAY_SECONDS} seconds (24h)` };
  }
  if (seconds < 1) return { ok: false, error: "Must be at least 1 second" };
  return { ok: true, seconds };
}

/** 28827 → "8h 27s", 0 → "0s". */
export function formatSeconds(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return parts.join(" ");
}

/**
 * The ONE rule of the LOG screen (UI-only, per design): an entry is
 * recorded only if the day's total stays within 24 hours.
 */
export function fitsInDay(currentDayTotal: number, seconds: number): boolean {
  return currentDayTotal + seconds <= DAY_SECONDS;
}

export function sumSeconds(entries: ReadonlyArray<{ seconds: number }>): number {
  return entries.reduce((acc, e) => acc + e.seconds, 0);
}
