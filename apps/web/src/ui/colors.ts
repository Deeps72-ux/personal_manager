/**
 * Activity colours, one system for the whole app: the split bars, a day's
 * entries, the calendar and Insights.
 *
 *   - a task's colour is its card's colour (from its id);
 *   - anything else typed as an activity gets its own steady colour from its
 *     words (the same words, the same colour, on every device);
 *   - RED is never an activity colour: it means "unlogged" (and a queued task
 *     waiting too long).
 */
import { useMemo } from "react";
import { activityKey } from "@pm/shared";
import { useLive } from "./services.tsx";

/** The reds (335°–25°) moved out to the nearest violet / orange. */
export function safeHue(h: number): number {
  const x = ((Math.round(h) % 360) + 360) % 360;
  if (x < 25) return 25 + x;
  if (x >= 335) return x - 25;
  return x;
}

const fnv = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** Stable per-card "personality" from the id: accent hue (never red) + slight tilt. */
export function cardLook(id: string): { hue: number; tilt: number } {
  const u = fnv(id);
  return { hue: safeHue(u % 360), tilt: ((u >>> 9) % 25) / 10 - 1.2 }; // -1.2° … +1.2°
}

/** The steady colour of an activity that is not a task. */
export const wordsHue = (title: string): number => safeHue(fnv(activityKey(title)) % 360);

/** Hue of an activity: its task's colour when it names a task, else its own. */
export function hueFor(title: string, tasks: readonly { id: string; title: string }[]): number {
  const k = activityKey(title);
  const t = tasks.find((x) => activityKey(x.title) === k);
  return t ? cardLook(t.id).hue : wordsHue(title);
}

/** `title → hue`, kept up to date with the task list. */
export function useActivityHue(): (title: string) => number {
  const tasks = useLive((s) => s.store.listTasks(), []);
  return useMemo(() => {
    const byKey = new Map((tasks ?? []).map((t) => [activityKey(t.title), cardLook(t.id).hue]));
    return (title: string) => byKey.get(activityKey(title)) ?? wordsHue(title);
  }, [tasks]);
}
