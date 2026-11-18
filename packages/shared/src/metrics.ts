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

/** "33.3%" — one decimal, trailing ".0" dropped. */
export function formatPercent(value: number): string {
  const s = (Math.round(value * 10) / 10).toFixed(1);
  return `${s.endsWith(".0") ? s.slice(0, -2) : s}%`;
}
