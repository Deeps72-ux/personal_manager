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

/** X-axis ticks: every 6 h for a day, every day for a week, every ~5 days for a month. */
export function spanTicks(span: Span, w: Window, locale?: string): Tick[] {
  const ticks: Tick[] = [];
  if (span === "day") {
    const s = new Date(w.start);
    for (let h = 0; h <= 24; h += 6) {
      const t = new Date(s.getFullYear(), s.getMonth(), s.getDate(), h).getTime();
      ticks.push({ t, label: `${pad2(h % 24 === 0 && h > 0 ? 24 : h)}:00` });
    }
    return ticks;
  }
  const s = new Date(w.start);
  for (let i = 0; ; i++) {
    const day = new Date(s.getFullYear(), s.getMonth(), s.getDate() + i);
    const t = day.getTime();
    if (t >= w.end) break;
    if (span === "week") {
      ticks.push({ t, label: day.toLocaleDateString(locale, { weekday: "short", day: "numeric" }) });
    } else if ((day.getDate() - 1) % 5 === 0 && day.getDate() <= 26) {
      ticks.push({ t, label: String(day.getDate()) });
    }
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
