/**
 * Pure helpers that shape data for display. No storage, no side effects.
 */
import {
  activityKey,
  compareRanked,
  daysInMonth,
  sumSeconds,
  uuidv7Time,
  type Day,
  type Folder,
  type HiddenActivity,
  type LogEntry,
  type PlanEntry,
  type Placement,
  type Task,
} from "@pm/shared";
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
 *                 (`folderId` = that folder), unless the card left that
 *                 folder's group (its placement's `ownRank`),
 *   - `card`:     else a rank the user typed on the card,
 *   - `position`: else its position in the list order (1 = first).
 * Ranks can tie. `position` never changes when ranks are typed: only drags,
 * the queue and new tasks reorder the list (and erase typed ranks).
 * `homeFolderId`: the nearest ranked folder above the card, even when it
 * left that folder's group (dragging it back among them rejoins it).
 */
export interface RankedCard {
  task: Task;
  rank: number;
  position: number;
  source: "folder" | "card" | "position";
  folderId: string | null;
  homeFolderId: string | null;
}

/**
 * Display order: by rank; on a tie, folder-ranked cards first, each folder's
 * cards together; then by position.
 */
export function sortRanked(cards: readonly RankedCard[]): RankedCard[] {
  const groupAt = new Map<string, number>();
  for (const c of [...cards].sort((a, b) => a.position - b.position)) {
    if (c.folderId && !groupAt.has(c.folderId)) groupAt.set(c.folderId, c.position);
  }
  const group = (c: RankedCard) => (c.folderId ? groupAt.get(c.folderId)! : c.position);
  return [...cards].sort(
    (a, b) =>
      a.rank - b.rank ||
      (a.source === "folder" ? 0 : 1) - (b.source === "folder" ? 0 : 1) ||
      group(a) - group(b) ||
      a.position - b.position,
  );
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
    const home = rankedFolder(task);
    const p = placementOf.get(task.id);
    const homeFolderId = home?.id ?? null;
    if (home && !p?.ownRank) return { task, rank: home.priority!, position: i + 1, source: "folder", folderId: home.id, homeFolderId };
    const typed = p?.userRank;
    if (typed !== null && typed !== undefined) return { task, rank: typed, position: i + 1, source: "card", folderId: null, homeFolderId };
    return { task, rank: i + 1, position: i + 1, source: "position", folderId: null, homeFolderId };
  });
  return sortRanked(cards);
}

/**
 * What a drop does to the list (pure: PRIORITY and the schedule editor both
 * use it). `order`: the list after the drop, top first, every card with its
 * new rank, positions renumbered.
 *
 *   - `group`:  the card was dropped among its own folder's cards (or next
 *               to them): it is (again) one of them;
 *   - `tie`:    dropped inside a group of tied cards (another folder's): it
 *               shares their rank, as its own rank;
 *   - `own`:    anywhere else: its position is its rank. Cards at and below
 *               the drop move down a step, a folder's group as one; a card
 *               that was in a folder's group leaves it (only that card).
 * Ranks typed on cards are erased (positions become the list as shown);
 * tied folder groups stay tied. `folderRanks`: each ranked folder's new rank.
 */
export interface DropResult {
  order: RankedCard[];
  mode: "group" | "tie" | "own";
  card: RankedCard;
  folderRanks: Map<string, number>;
}

export function dropCard(cards: readonly RankedCard[], from: number, to: number): DropResult | null {
  const card = cards[from];
  if (!card) return null;
  const list = cards.filter((_, i) => i !== from);
  const at = Math.max(0, Math.min(Math.trunc(to), list.length));
  list.splice(at, 0, card);
  const prev = list[at - 1];
  const next = list[at + 1];
  const home = card.homeFolderId;
  const inHome = (c: RankedCard | undefined) => !!c && c !== card && c.source === "folder" && c.folderId === home;
  // Tied folder groups: cards ranked by a folder with the same rank, side by side.
  const tieKey = (c: RankedCard | undefined) => (c && c !== card && c.source === "folder" ? `f${c.rank}` : null);

  let mode: DropResult["mode"];
  let key: string | null;
  // The only card of its folder's group carries the folder (and its rank) along.
  const alone = card.source === "folder" && !list.some(inHome);
  if (alone) {
    mode = "group";
    key = null;
  } else if (home && (inHome(prev) || inHome(next))) {
    mode = "group";
    key = `f${(prev && inHome(prev) ? prev : next)!.rank}`;
  } else if (tieKey(prev) !== null && tieKey(prev) === tieKey(next)) {
    mode = "tie";
    key = tieKey(prev);
  } else {
    mode = "own";
    key = null;
  }

  const order: RankedCard[] = [];
  const folderRanks = new Map<string, number>();
  let lastKey: string | null = null;
  list.forEach((c, i) => {
    const k = c === card ? key : tieKey(c);
    const rank = k !== null && k === lastKey ? order[i - 1]!.rank : i + 1;
    lastKey = k;
    let out: RankedCard;
    if (c === card) {
      if (mode === "group") out = { ...c, rank, position: i + 1, source: "folder", folderId: home };
      else if (mode === "tie") out = { ...c, rank, position: i + 1, source: "card", folderId: null };
      else out = { ...c, rank, position: i + 1, source: "position", folderId: null };
    } else if (c.source === "folder") out = { ...c, rank, position: i + 1 };
    else out = { ...c, rank, position: i + 1, source: "position" };
    if (out.source === "folder" && out.folderId && !folderRanks.has(out.folderId)) folderRanks.set(out.folderId, rank);
    order.push(out);
  });
  return { order, mode, card: order[at]!, folderRanks };
}

/** A list kept for later, from cards as shown. */
export function planEntries(cards: readonly RankedCard[]): PlanEntry[] {
  return cards.map((c) => ({
    taskId: c.task.id,
    title: c.task.title,
    rank: c.rank,
    folderId: c.source === "folder" ? c.folderId : null,
  }));
}

/**
 * Ranks after cards were added or left out of a kept list: tied cards stay
 * tied (a folder's group, or cards that shared a typed rank), every other
 * card takes its position. `fresh` cards (new tasks) never tie.
 */
export function closeUpRanks<T extends { rank: number; folderId: string | null }>(items: readonly T[], fresh: ReadonlySet<T> = new Set()): T[] {
  const out: T[] = [];
  let lastKey: string | null = null;
  items.forEach((c, i) => {
    const key = fresh.has(c) ? null : `${c.folderId ? "f" : "c"}${c.rank}`;
    const rank = key !== null && key === lastKey ? out[i - 1]!.rank : i + 1;
    lastKey = key;
    out.push({ ...c, rank });
  });
  return out;
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

/**
 * The task cards under the TIMER / LOG bar, filtered by what is typed so far
 * (a trailing ";" ignored; no case). A task matches when its title, its
 * folder's name or its description contains the text. Best first: titles
 * that start with it, then titles with a word that starts with it, then
 * other title matches, then folder or description matches; ties keep the
 * given (priority) order. Nothing typed: every task.
 */
export function filterPicks(tasks: readonly Task[], text: string, folderName: (t: Task) => string | null): Task[] {
  const q = activityKey(text);
  if (!q) return [...tasks];
  const score = (t: Task): number => {
    const title = t.title.toLocaleLowerCase();
    if (title.startsWith(q)) return 0;
    if (title.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    if (title.includes(q)) return 2;
    if ((folderName(t) ?? "").toLocaleLowerCase().includes(q)) return 3;
    if ((t.description ?? "").toLocaleLowerCase().includes(q)) return 4;
    return -1;
  };
  return tasks
    .map((t, i) => ({ t, i, s: score(t) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.t);
}

/**
 * Activities logged before that are not tasks (e.g. "Lunch"), most recent
 * first, that contain what is typed. Nothing typed: none. At most `limit`.
 */
/**
 * Activities hidden from the chips (by name, ignoring case). A hidden name
 * comes back once a log of it is created after it was hidden.
 */
export function hiddenKeys(entries: readonly LogEntry[], hidden: readonly HiddenActivity[]): Set<string> {
  const at = new Map<string, number>();
  for (const h of hidden) {
    const k = activityKey(h.name);
    at.set(k, Math.max(at.get(k) ?? 0, h.hiddenAt));
  }
  for (const e of entries) {
    const k = activityKey(e.taskTitle);
    const h = at.get(k);
    if (h !== undefined && uuidv7Time(e.id) > h) at.delete(k);
  }
  return new Set(at.keys());
}

export interface ActivityStat {
  key: string;
  title: string;
  count: number;
  /** When it was last done (log start; older logs: creation). */
  lastMs: number;
  hidden: boolean;
}

/** Every activity logged before that is not a task, most recently used first. */
export function activityStats(
  entries: readonly LogEntry[],
  tasks: readonly Task[],
  hidden: readonly HiddenActivity[] = [],
): ActivityStat[] {
  const taskKeys = new Set(tasks.map((t) => activityKey(t.title)));
  const hiddenSet = hiddenKeys(entries, hidden);
  const stats = new Map<string, ActivityStat>();
  for (const e of entries) {
    const key = activityKey(e.taskTitle);
    if (!key || taskKeys.has(key)) continue;
    const t = e.startMs ?? uuidv7Time(e.id);
    const cur = stats.get(key);
    if (!cur) stats.set(key, { key, title: e.taskTitle.trim(), count: 1, lastMs: t, hidden: hiddenSet.has(key) });
    else {
      cur.count++;
      if (t > cur.lastMs) Object.assign(cur, { lastMs: t, title: e.taskTitle.trim() });
    }
  }
  return [...stats.values()].sort((a, b) => b.lastMs - a.lastMs || (a.key < b.key ? -1 : 1));
}

/**
 * Chips for the text typed so far: activities logged before that are not
 * tasks and not hidden, those starting with the text first, then the most
 * recent.
 */
export function pastActivities(
  entries: readonly LogEntry[],
  tasks: readonly Task[],
  text: string,
  limit = 8,
  hidden: readonly HiddenActivity[] = [],
): string[] {
  const q = activityKey(text);
  if (!q) return [];
  const starts = (s: string) => (s.toLocaleLowerCase().startsWith(q) ? 0 : 1);
  return activityStats(entries, tasks, hidden)
    .filter((a) => !a.hidden && a.key.includes(q))
    .sort((a, b) => starts(a.title) - starts(b.title) || b.lastMs - a.lastMs)
    .slice(0, limit)
    .map((x) => x.title);
}

/** TIMER chip: the bar becomes exactly `title;` (one activity per log). */
export const chipText = (title: string): string => `${title.trim()};`;
