/**
 * INSIGHTS: pure helpers that turn scored log rows into chart points and
 * time windows. No storage, no React.
 */
import { uuidv7Time, type Day, type LogEntry } from "@pm/shared";
import { pad2 } from "./views.ts";

export type Span = "day" | "week" | "month";

export interface InsightPoint {
  /** When ✓ was pressed (Unix ms). */
  t: number;
  title: string;
  seconds: number;
  focus: number;
  deviation: number | null;
}

/**
 * One point per ✓ press. A press that crossed midnight wrote several rows
 * with the same id time and score: they are merged (seconds added up).
 * Rows without a focus score (manual logs, older logs) are skipped.
 */
export function insightPoints(entries: readonly LogEntry[]): InsightPoint[] {
  const byPress = new Map<string, InsightPoint>();
  for (const e of entries) {
    if (e.focus === null || e.focus === undefined) continue;
    const t = uuidv7Time(e.id);
    const key = `${t}|${e.taskTitle}`;
    const p = byPress.get(key);
    if (p) p.seconds += e.seconds;
    else byPress.set(key, { t, title: e.taskTitle, seconds: e.seconds, focus: e.focus, deviation: e.deviation ?? null });
  }
  return [...byPress.values()].sort((a, b) => a.t - b.t);
}

export interface Window {
  start: number;
  end: number;
}

/** The local-time window of `span` containing `anchor`, moved by `offset` whole spans. */
export function spanWindow(span: Span, anchor: number, offset: number): Window {
  const d = new Date(anchor);
  if (span === "day") {
    const s = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
    return { start: s.getTime(), end: new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1).getTime() };
  }
  if (span === "week") {
    const monday = d.getDate() - ((d.getDay() + 6) % 7);
    const s = new Date(d.getFullYear(), d.getMonth(), monday + 7 * offset);
    return { start: s.getTime(), end: new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7).getTime() };
  }
  const s = new Date(d.getFullYear(), d.getMonth() + offset, 1);
  return { start: s.getTime(), end: new Date(s.getFullYear(), s.getMonth() + 1, 1).getTime() };
}

export const localDay = (ms: number): Day => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/** Average weighted by logged seconds; null if there is nothing to average. */
export function weightedMean(points: readonly InsightPoint[], pick: (p: InsightPoint) => number | null): number | null {
  let sum = 0;
  let weight = 0;
  for (const p of points) {
    const v = pick(p);
    if (v === null) continue;
    sum += v * p.seconds;
    weight += p.seconds;
  }
  return weight === 0 ? null : sum / weight;
}

export interface Tick {
  t: number;
  label: string;
}

// ───────────── free zoom / pan of the time axis ─────────────

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Narrowest view: 10 s (1 s is the least count). Widest: 10 years. */
export const MIN_VIEW_MS = 10 * SEC;
export const MAX_VIEW_MS = 3653 * DAY;

/** Keep the width within limits (around the centre); position is free. */
export function clampWindow(w: Window): Window {
  const width = w.end - w.start;
  if (width >= MIN_VIEW_MS && width <= MAX_VIEW_MS) return w;
  const target = Math.min(MAX_VIEW_MS, Math.max(MIN_VIEW_MS, width));
  const mid = (w.start + w.end) / 2;
  return { start: mid - target / 2, end: mid + target / 2 };
}

/** Zoom by `factor` (<1 = in) keeping time `anchor` where it is on screen. */
export function zoomWindow(w: Window, factor: number, anchor = (w.start + w.end) / 2): Window {
  const width = w.end - w.start;
  const next = Math.min(MAX_VIEW_MS, Math.max(MIN_VIEW_MS, width * factor));
  const frac = width === 0 ? 0.5 : (anchor - w.start) / width;
  const start = anchor - frac * next;
  return { start, end: start + next };
}

export const panWindow = (w: Window, ms: number): Window => ({ start: w.start + ms, end: w.end + ms });

/** The preset this window is exactly, if any. */
export function matchSpan(w: Window): Span | null {
  for (const s of ["day", "week", "month"] as const) {
    const c = spanWindow(s, w.start, 0);
    if (c.start === w.start && c.end === w.end) return s;
  }
  return null;
}

type Unit = "s" | "m" | "h" | "d" | "w" | "M" | "y";
const LADDER: [Unit, number, number][] = [
  ["s", 1, SEC], ["s", 2, 2 * SEC], ["s", 5, 5 * SEC], ["s", 10, 10 * SEC], ["s", 15, 15 * SEC], ["s", 30, 30 * SEC],
  ["m", 1, MIN], ["m", 2, 2 * MIN], ["m", 5, 5 * MIN], ["m", 10, 10 * MIN], ["m", 15, 15 * MIN], ["m", 30, 30 * MIN],
  ["h", 1, HOUR], ["h", 2, 2 * HOUR], ["h", 3, 3 * HOUR], ["h", 6, 6 * HOUR], ["h", 12, 12 * HOUR],
  ["d", 1, DAY], ["d", 2, 2 * DAY], ["w", 1, 7 * DAY],
  ["M", 1, 30 * DAY], ["M", 3, 91 * DAY], ["M", 6, 182 * DAY],
  ["y", 1, 365 * DAY], ["y", 2, 730 * DAY], ["y", 5, 1826 * DAY],
];

/** Local date with one field moved by `k` (Date normalises overflow, DST-safe). */
function step(base: Date, unit: Unit, k: number): Date {
  const [y, mo, d, h, mi, s] = [base.getFullYear(), base.getMonth(), base.getDate(), base.getHours(), base.getMinutes(), base.getSeconds()];
  switch (unit) {
    case "s": return new Date(y, mo, d, h, mi, s + k);
    case "m": return new Date(y, mo, d, h, mi + k);
    case "h": return new Date(y, mo, d, h + k);
    case "d": return new Date(y, mo, d + k);
    case "w": return new Date(y, mo, d + 7 * k);
    case "M": return new Date(y, mo + k, 1);
    case "y": return new Date(y + k, 0, 1);
  }
}

/** First tick at or before `t`, aligned to the unit (and to multiples of n). */
function floorTo(t: number, unit: Unit, n: number): Date {
  const d = new Date(t);
  const [y, mo, day, h, mi, s] = [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
  switch (unit) {
    case "s": return new Date(y, mo, day, h, mi, s - (s % n));
    case "m": return new Date(y, mo, day, h, mi - (mi % n));
    case "h": return new Date(y, mo, day, h - (h % n));
    case "d": return new Date(y, mo, day - ((day - 1) % n));
    case "w": return new Date(y, mo, day - ((d.getDay() + 6) % 7)); // Monday
    case "M": return new Date(y, mo - (mo % n), 1);
    case "y": return new Date(y - (y % n), 0, 1);
  }
}

const p2 = (n: number) => String(n).padStart(2, "0");

function tickLabel(d: Date, unit: Unit, width: number, locale?: string): string {
  const midnight = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
  const dayMonth = () => d.toLocaleDateString(locale, { day: "numeric", month: "short" });
  switch (unit) {
    case "s": return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    case "m":
    case "h": return midnight ? dayMonth() : `${p2(d.getHours())}:${p2(d.getMinutes())}`;
    case "d": return width <= 8 * DAY ? d.toLocaleDateString(locale, { weekday: "short", day: "numeric" }) : dayMonth();
    case "w": return dayMonth();
    case "M": return d.getMonth() === 0 ? String(d.getFullYear()) : d.toLocaleDateString(locale, { month: "short" });
    case "y": return String(d.getFullYear());
  }
}

/**
 * X-axis ticks for any window: the finest step (1 s … 5 y) that keeps at most
 * `maxTicks` labels, aligned to local clock / calendar boundaries.
 */
export function timeTicks(w: Window, maxTicks: number, locale?: string): Tick[] {
  const width = w.end - w.start;
  const [unit, n] = LADDER.find(([, , ms]) => width / ms <= Math.max(2, maxTicks)) ?? LADDER.at(-1)!;
  const first = floorTo(w.start, unit, n);
  const ticks: Tick[] = [];
  for (let k = 0; k < 1000; k++) {
    const d = step(first, unit, k * n);
    const t = d.getTime();
    if (t > w.end) break;
    if (t >= w.start) ticks.push({ t, label: tickLabel(d, unit, width, locale) });
  }
  return ticks;
}

/** "Thu, 19 Nov 2026", "16 – 22 Nov 2026" or "November 2026". */
export function spanLabel(span: Span, w: Window, locale?: string): string {
  const s = new Date(w.start);
  if (span === "day") {
    return s.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  }
  if (span === "month") return s.toLocaleDateString(locale, { month: "long", year: "numeric" });
  const e = new Date(w.end - 1);
  const from = s.toLocaleDateString(locale, { day: "numeric", month: s.getMonth() === e.getMonth() ? undefined : "short" });
  return `${from} – ${e.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" })}`;
}

/** Heading for any window: a preset's name, else "start – end" at a fitting precision. */
export function windowLabel(w: Window, locale?: string): string {
  const span = matchSpan(w);
  if (span) return spanLabel(span, w, locale);
  const width = w.end - w.start;
  const s = new Date(w.start);
  const e = new Date(w.end);
  const sameDay = localDay(w.start) === localDay(w.end);
  const clock = (d: Date) =>
    width < 10 * MIN ? `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` : `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const date = (d: Date, year: boolean) =>
    d.toLocaleDateString(locale, { day: "numeric", month: "short", year: year ? "numeric" : undefined });
  if (sameDay) return `${date(s, true)}, ${clock(s)} – ${clock(e)}`;
  if (width < 3 * DAY) return `${date(s, false)} ${clock(s)} – ${date(e, false)} ${clock(e)}`;
  return `${date(s, s.getFullYear() !== e.getFullYear())} – ${date(e, true)}`;
}
