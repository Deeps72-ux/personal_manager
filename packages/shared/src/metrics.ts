/**
 * FOCUS and DEVIATION of one TIMER log, both in percent (0–100).
 * Pure functions: computed once, when ✓ is pressed, then stored on the log.
 *
 *   F = 100 / k                              k = distinct activities logged
 *
 *   D = 100 · ((m − 1) + φ) / (n + 1)
 *   φ = 1 − ∏_{ℓ ∈ L∖{ℓ*}} (1 − r_ℓ / (n + 2))
 *
 *   n  = tasks in the priority list
 *   r_ℓ = rank of activity ℓ (1 = top); not in the list → n + 1
 *   m  = best (smallest) rank logged, ℓ* = that activity
 *   φ ∈ [0, 1): penalty for every other activity, never crossing into the next band
 *
 * Order guaranteed: {A} = 0 < {A, …} < {B} < {B, …} < {C} < …
 */

/** Activities typed in the TIMER bar: split on ";", trimmed, empties and repeats dropped. */
export function splitActivities(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(";")) {
    const a = raw.trim();
    const key = a.toLocaleLowerCase();
    if (!a || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** F = 100 / k. Null when nothing was logged. */
export function focusPercent(activities: readonly string[]): number | null {
  return activities.length === 0 ? null : 100 / activities.length;
}

/**
 * D in percent. `priorityTitles` is the priority list top-first.
 * Null when nothing was logged or the priority list is empty (no reference).
 */
export function deviationPercent(activities: readonly string[], priorityTitles: readonly string[]): number | null {
  const n = priorityTitles.length;
  if (activities.length === 0 || n === 0) return null;

  const rankOf = new Map<string, number>();
  priorityTitles.forEach((t, i) => {
    const key = t.trim().toLocaleLowerCase();
    if (!rankOf.has(key)) rankOf.set(key, i + 1);
  });
  const ranks = activities.map((a) => rankOf.get(a.trim().toLocaleLowerCase()) ?? n + 1).sort((a, b) => a - b);

  const m = ranks[0]!;
  const phi = 1 - ranks.slice(1).reduce((p, r) => p * (1 - r / (n + 2)), 1);
  return (100 * (m - 1 + phi)) / (n + 1);
}

// ───────────── one activity per log ─────────────

export type ActivityResult = { ok: true; activity: string } | { ok: false; error: string };

export const ONE_ACTIVITY_ERROR = "One activity per log: nothing can come after ';'";

/** True if `text` has something other than spaces after a ";" (a second activity). */
export function hasTextAfterSeparator(text: string): boolean {
  const at = text.indexOf(";");
  return at !== -1 && text.slice(at + 1).trim() !== "";
}

/**
 * A log holds exactly ONE activity, written `Activity;`. The closing ";" is
 * added if missing; anything after it is refused. A task title that itself
 * contains ";" (made before this rule) is accepted when typed exactly.
 */
export function parseActivity(text: string, knownTitles: readonly string[] = []): ActivityResult {
  let a = text.trim();
  if (a.endsWith(";")) a = a.slice(0, -1).trim();
  if (!a) return { ok: false, error: "Type what you did" };
  if (a.includes(";") && !knownTitles.some((t) => t.trim() === a)) return { ok: false, error: ONE_ACTIVITY_ERROR };
  return { ok: true, activity: a };
}

/** How a title is matched against the priority list. */
export const activityKey = (title: string): string => {
  let t = title.trim();
  if (t.endsWith(";")) t = t.slice(0, -1).trim();
  return t.toLocaleLowerCase();
};

// ───────────── deviation from the priority history ─────────────

/** D of one activity against one list: 100·(m − 1)/(n + 1); not listed → m = n + 1. Null if the list is empty. */
export function rankDeviation(activity: string, titles: readonly string[]): number | null {
  const n = titles.length;
  if (n === 0) return null;
  const key = activityKey(activity);
  const i = titles.findIndex((t) => activityKey(t) === key);
  const m = i === -1 ? n + 1 : i + 1;
  return (100 * (m - 1)) / (n + 1);
}

export interface PriorityAt {
  at: number;
  titles: readonly string[];
  confirmed?: boolean | null | undefined;
}

/**
 * The snapshots scores are taken against, sorted by time: the CONFIRMED ones
 * only. Snapshots taken automatically by older versions (on every drag, never
 * confirmed; possibly still sent by a device not updated yet) never count:
 * time before the first confirm is not scored.
 */
export function scoringHistory<T extends PriorityAt>(history: readonly T[]): T[] {
  return history.filter((s) => s.confirmed === true).sort((a, b) => a.at - b.at);
}

/** The latest confirmed snapshot, if any. */
export function latestConfirmed<T extends PriorityAt>(history: readonly T[]): T | null {
  let out: T | null = null;
  for (const s of history) if (s.confirmed === true && (!out || s.at >= out.at)) out = s;
  return out;
}

/**
 * One part of a log scored against ONE snapshot. `top`: that snapshot's #1
 * task; `deviation`: the activity's D against it. Both null when no
 * snapshot was in force (before the first one ever).
 */
export interface DeviationSlice {
  start: number;
  end: number;
  top: string | null;
  deviation: number | null;
}

/**
 * Cut [startMs, endMs) wherever the scoring snapshot changed, and score each
 * part on its own (no average over the whole log). `history` is the raw
 * PRIORITY HISTORY; `scoringHistory` is applied here. Neighbouring parts with
 * the same #1 task and the same score are joined.
 */
export function deviationSlices(
  activity: string,
  startMs: number,
  endMs: number,
  history: readonly PriorityAt[],
): DeviationSlice[] {
  if (endMs <= startMs) return [];
  const h = scoringHistory(history);
  const out: DeviationSlice[] = [];
  const push = (s: DeviationSlice) => {
    if (s.end <= s.start) return;
    const last = out.at(-1);
    if (last && last.end === s.start && last.top === s.top && last.deviation === s.deviation) last.end = s.end;
    else out.push(s);
  };
  const firstAt = h[0]?.at ?? Infinity;
  push({ start: startMs, end: Math.min(endMs, firstAt), top: null, deviation: null });
  for (let k = 0; k < h.length; k++) {
    const from = Math.max(startMs, h[k]!.at);
    const to = Math.min(endMs, h[k + 1]?.at ?? Infinity);
    if (to <= from) continue;
    const titles = h[k]!.titles;
    push({ start: from, end: to, top: titles[0] ?? null, deviation: rankDeviation(activity, titles) });
  }
  return out;
}

/** FOCUS of one clock hour: 100 / (1 + switches). */
export const hourFocus = (switches: number): number => 100 / (1 + switches);

/** "33.3%" — one decimal, trailing ".0" dropped. */
export function formatPercent(value: number): string {
  const s = (Math.round(value * 10) / 10).toFixed(1);
  return `${s.endsWith(".0") ? s.slice(0, -2) : s}%`;
}
