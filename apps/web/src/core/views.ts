/**
 * Pure helpers that shape data for display. No storage, no side effects.
 */
import { compareRanked, daysInMonth, sumSeconds, type Day, type Folder, type LogEntry, type Placement, type Task } from "@pm/shared";
import { buildFolderTree } from "./folders.ts";

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
 * One card of the visible PRIORITY list with its rank:
 *   - `folder`:   the nearest folder above it that has a rank gives it
 *                 (`folderId` = that folder),
 *   - `card`:     else a rank the user typed on the card,
 *   - `position`: else its position in the list order (1 = first).
 * Ranks can tie. `position` never changes when ranks are typed: only drags,
 * the queue and new tasks reorder the list (and erase typed ranks).
 */
export interface RankedCard {
  task: Task;
  rank: number;
  position: number;
  source: "folder" | "card" | "position";
  folderId: string | null;
}

/**
 * The visible list (queued placements must be left out) as shown: by rank;
 * on a tie, folder-ranked cards first, each folder's tasks together; then by
 * position.
 */
export function rankedList(tasks: readonly Task[], visible: readonly Placement[], folders: readonly Folder[]): RankedCard[] {
  const order = priorityOrder(tasks, visible);
  const placementOf = new Map(visible.map((p) => [p.taskId, p]));
  const tree = buildFolderTree(folders, tasks);
  const rankedFolder = (task: Task): Folder | null => {
    for (let id = tree.folderOf(task); id !== null; id = tree.parentOf(id)) {
      const f = tree.get(id)!;
      if (f.priority !== null && f.priority !== undefined) return f;
    }
    return null;
  };
  const cards: RankedCard[] = order.map((task, i) => {
    const f = rankedFolder(task);
    const typed = placementOf.get(task.id)?.userRank;
    if (f) return { task, rank: f.priority!, position: i + 1, source: "folder", folderId: f.id };
    if (typed !== null && typed !== undefined) return { task, rank: typed, position: i + 1, source: "card", folderId: null };
    return { task, rank: i + 1, position: i + 1, source: "position", folderId: null };
  });
  const groupAt = new Map<string, number>();
  for (const c of cards) if (c.folderId && !groupAt.has(c.folderId)) groupAt.set(c.folderId, c.position);
  const group = (c: RankedCard) => (c.folderId ? groupAt.get(c.folderId)! : c.position);
  return cards.sort(
    (a, b) =>
      a.rank - b.rank ||
      (a.source === "folder" ? 0 : 1) - (b.source === "folder" ? 0 : 1) ||
      group(a) - group(b) ||
      a.position - b.position,
  );
}

/**
 * The PRIORITY screen's two parts: the visible list (as ranked) and the
 * WAITING QUEUE (oldest first: the first one in is the first one out).
 */
export function splitPriority(
  tasks: readonly Task[],
  placements: readonly Placement[],
  folders: readonly Folder[],
): { list: Task[]; ranked: RankedCard[]; queue: QueuedTask[] } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ranked = rankedList(
    tasks,
    placements.filter((p) => !isQueued(p)),
    folders,
  );
  const list = ranked.map((c) => c.task);
  const queue = placements
    .filter(isQueued)
    .map((p) => ({ task: byId.get(p.taskId), queuedAt: p.queuedAt! }))
    .filter((q): q is QueuedTask => q.task !== undefined)
    .sort((a, b) => a.queuedAt - b.queuedAt || (a.task.id < b.task.id ? -1 : 1));
  return { list, ranked, queue };
}

/**
 * Titles to tap in the TIMER and the LOG: the visible list, then the queue
 * (oldest first). The queue is offered for convenience only: it is never
 * part of the scoring order.
 */
export function pickOrder(tasks: readonly Task[], placements: readonly Placement[], folders: readonly Folder[]): Task[] {
  const { list, queue } = splitPriority(tasks, placements, folders);
  return [...list, ...queue.map((q) => q.task)];
}

/** What the confirm icon snapshots: the visible list's titles, best first, and their ranks. */
export interface ScoringOrder {
  titles: string[];
  ranks: number[];
}

export function visibleOrder(tasks: readonly Task[], placements: readonly Placement[], folders: readonly Folder[]): ScoringOrder {
  const { ranked } = splitPriority(tasks, placements, folders);
  return { titles: ranked.map((c) => c.task.title), ranks: ranked.map((c) => c.rank) };
}

/**
 * True when the confirm icon can be pressed: the visible list is not empty
 * and its order or ranks differ from the latest CONFIRMED snapshot (whose
 * ranks are positions if it has none: an older snapshot).
 */
export function canConfirm(
  now: ScoringOrder,
  latest: { titles: readonly string[]; ranks?: readonly number[] | null | undefined } | null,
): boolean {
  if (now.titles.length === 0) return false;
  if (!latest) return true;
  if (latest.titles.length !== now.titles.length || latest.titles.some((t, i) => t !== now.titles[i])) return true;
  const ranks = latest.ranks && latest.ranks.length === latest.titles.length ? latest.ranks : latest.titles.map((_, i) => i + 1);
  return ranks.some((r, i) => r !== now.ranks[i]);
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
