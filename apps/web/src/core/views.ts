/**
 * Pure helpers that shape data for display. No storage, no side effects.
 */
import { compareRanked, daysInMonth, sumSeconds, type Day, type LogEntry, type Placement, type Task } from "@pm/shared";

/** Every placed task in rank order (id tie-break), queued ones included. Same on every device. */
export function priorityOrder(tasks: readonly Task[], placements: readonly Placement[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return placements
    .map((p) => ({ id: p.taskId, rank: p.rank }))
    .sort(compareRanked)
    .map((r) => byId.get(r.id))
    .filter((t): t is Task => t !== undefined);
}

export const isQueued = (p: Placement): boolean => p.queuedAt !== null && p.queuedAt !== undefined;

export interface QueuedTask {
  task: Task;
  queuedAt: number;
}

/**
 * The PRIORITY screen's two parts: the visible list (rank order) and the
 * WAITING QUEUE (oldest first: the first one in is the first one out).
 */
export function splitPriority(
  tasks: readonly Task[],
  placements: readonly Placement[],
): { list: Task[]; queue: QueuedTask[] } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const list = priorityOrder(
    tasks,
    placements.filter((p) => !isQueued(p)),
  );
  const queue = placements
    .filter(isQueued)
    .map((p) => ({ task: byId.get(p.taskId), queuedAt: p.queuedAt! }))
    .filter((q): q is QueuedTask => q.task !== undefined)
    .sort((a, b) => a.queuedAt - b.queuedAt || (a.task.id < b.task.id ? -1 : 1));
  return { list, queue };
}

/**
 * Titles to tap in the TIMER and the LOG: the visible list, then the queue
 * (oldest first). The queue is offered for convenience only: it is never
 * part of the scoring order.
 */
export function pickOrder(tasks: readonly Task[], placements: readonly Placement[]): Task[] {
  const { list, queue } = splitPriority(tasks, placements);
  return [...list, ...queue.map((q) => q.task)];
}

/** Titles of the visible list, best first: what the confirm icon snapshots. */
export const visibleTitles = (tasks: readonly Task[], placements: readonly Placement[]): string[] =>
  splitPriority(tasks, placements).list.map((t) => t.title);

/**
 * True when the confirm icon can be pressed: the visible list is not empty
 * and its order differs from the latest CONFIRMED snapshot.
 */
export function canConfirm(titles: readonly string[], latest: { titles: readonly string[] } | null): boolean {
  if (titles.length === 0) return false;
  if (!latest) return true;
  return latest.titles.length !== titles.length || latest.titles.some((t, i) => t !== titles[i]);
}

export function sortedRanks(placements: readonly Placement[]): string[] {
  return placements
    .map((p) => ({ id: p.taskId, rank: p.rank }))
    .sort(compareRanked)
    .map((p) => p.rank);
}

export const pad2 = (n: number) => String(n).padStart(2, "0");
export const toDay = (year: number, month: number, day: number): Day => `${year}-${pad2(month)}-${pad2(day)}`;

export interface CalendarCell {
  day: Day;
  dayOfMonth: number;
  inMonth: boolean;
}

/** Month grid for the LOG calendar: Monday-first weeks, padded with neighbour days. */
export function monthGrid(year: number, month: number): CalendarCell[][] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7; // Monday = 0
  const cells: CalendarCell[] = [];
  const start = Date.UTC(year, month - 1, 1 - lead);
  const total = Math.ceil((lead + daysInMonth(year, month)) / 7) * 7;
  for (let i = 0; i < total; i++) {
    const d = new Date(start + i * 86_400_000);
    cells.push({
      day: toDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()),
      dayOfMonth: d.getUTCDate(),
      inMonth: d.getUTCMonth() === month - 1,
    });
  }
  const weeks: CalendarCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function totalsByDay(entries: readonly LogEntry[]): Map<Day, number> {
  const m = new Map<Day, number>();
  for (const e of entries) m.set(e.day, (m.get(e.day) ?? 0) + e.seconds);
  return m;
}

export { sumSeconds };

export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/** "Thu, 5 Nov 2026" in the device's locale, without timezone shifts. */
export function formatDayLong(day: Day, locale?: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatMonth(year: number, month: number, locale?: string): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** TIMER chip: the bar becomes exactly `title;` (one activity per log). */
export const chipText = (title: string): string => `${title.trim()};`;
