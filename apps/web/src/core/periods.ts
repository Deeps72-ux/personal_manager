/**
 * PAST PRIORITY LISTS: which list was in force when, like the LOG shows
 * logs. Built from the same timeline scores use (confirmed lists with the
 * scheduled slots applied), so a period here is exactly what was scored.
 */
import {
  activityKey,
  dayBounds,
  effectiveHistory,
  type Day,
  type PlanEntry,
  type PlanList,
  type PrioritySlot,
  type PrioritySnapshot,
} from "@pm/shared";

/**
 * - confirm:   a list confirmed with ✓ (outside a slot, or during one: then
 *              it lasts until the slot ends);
 * - slot:      a scheduled list, in force from its start;
 * - back:      the list from before a slot, back when it ended;
 * - scheduled: a slot still to come.
 */
export type PeriodKind = "confirm" | "slot" | "back" | "scheduled";

export interface PriorityPeriod {
  key: string;
  kind: PeriodKind;
  fromMs: number;
  /** null: still in force. */
  toMs: number | null;
  titles: readonly string[];
  ranks: readonly number[];
  /** The slot it belongs to (slot, back, scheduled). */
  slotId: string | null;
}

const ranksOf = (titles: readonly string[], ranks: readonly number[] | null | undefined) =>
  ranks && ranks.length === titles.length ? ranks : titles.map((_, i) => i + 1);

/**
 * Every list in force up to `now` (empty lists, when none was, are left out),
 * then every slot still to come. Oldest first.
 */
export function priorityPeriods(
  history: readonly PrioritySnapshot[],
  slots: readonly PrioritySlot[],
  now: number,
): PriorityPeriod[] {
  const slotIds = new Set(slots.map((s) => s.id));
  const timeline = effectiveHistory(history, slots);
  // The slot whose end each "back" event is (events without an id are slot ends).
  const endOf = (at: number) => slots.find((s) => s.endMs === at) ?? slots.find((s) => s.startMs < at && at <= s.endMs);
  const out: PriorityPeriod[] = [];
  const past = timeline.filter((e) => e.at <= now);
  past.forEach((e, i) => {
    if (e.titles.length === 0) return;
    const next = timeline[i + 1];
    const kind: PeriodKind = e.id && slotIds.has(e.id) ? "slot" : e.id ? "confirm" : "back";
    out.push({
      key: `${e.id ?? "back"}:${e.at}`,
      kind,
      fromMs: e.at,
      toMs: next && next.at <= now ? next.at : null,
      titles: e.titles,
      ranks: ranksOf(e.titles, e.ranks),
      slotId: kind === "slot" ? e.id! : kind === "back" ? (endOf(e.at)?.id ?? null) : null,
    });
  });
  for (const s of slots) {
    if (s.startMs <= now) continue;
    out.push({
      key: `scheduled:${s.id}`,
      kind: "scheduled",
      fromMs: s.startMs,
      toMs: s.endMs,
      titles: s.list.entries.map((e) => e.title),
      ranks: s.list.entries.map((e) => e.rank),
      slotId: s.id,
    });
  }
  return out.sort((a, b) => a.fromMs - b.fromMs || (a.kind === "scheduled" ? 1 : 0) - (b.kind === "scheduled" ? 1 : 0));
}

/** A period cut to one day, like a log that crosses midnight. */
export interface DayPeriod {
  period: PriorityPeriod;
  /** Within the day. */
  start: number;
  end: number;
  /** It goes on past the day's end, or began before its start. */
  cutStart: boolean;
  cutEnd: boolean;
}

/** The periods of `day` (cut at midnight), oldest first. A period still in force runs to `now`. */
export function periodsForDay(periods: readonly PriorityPeriod[], day: Day, now: number): DayPeriod[] {
  const { start, end } = dayBounds(day);
  const out: DayPeriod[] = [];
  for (const p of periods) {
    const to = p.toMs ?? Math.max(now, p.fromMs);
    if (to <= start || p.fromMs >= end) continue;
    const s = Math.max(p.fromMs, start);
    const e = Math.min(to, end);
    if (e <= s && !(p.toMs === null && p.fromMs < end)) continue;
    out.push({ period: p, start: s, end: Math.max(e, s), cutStart: p.fromMs < start, cutEnd: to > end });
  }
  return out;
}

interface TaskLike {
  id: string;
  title: string;
}

/**
 * A past list (titles and ranks only) as a list to restore or schedule:
 * each title goes to a task with that title today (deleted tasks drop out).
 * Cards of a ranked folder that all shared one rank keep it as the folder's
 * rank (`homeOf`: each task's nearest ranked folder today); otherwise each
 * card gets its own rank.
 */
export function listFromTitles(
  titles: readonly string[],
  ranks: readonly number[],
  tasks: readonly TaskLike[],
  homeOf: ReadonlyMap<string, string | null>,
  savedAt: number,
): PlanList {
  const byTitle = new Map<string, TaskLike[]>();
  for (const t of tasks) {
    const k = activityKey(t.title);
    byTitle.set(k, [...(byTitle.get(k) ?? []), t]);
  }
  const used = new Set<string>();
  const found: { task: TaskLike; rank: number }[] = [];
  titles.forEach((title, i) => {
    const task = (byTitle.get(activityKey(title)) ?? []).find((t) => !used.has(t.id));
    if (!task) return;
    used.add(task.id);
    found.push({ task, rank: ranks[i] ?? i + 1 });
  });
  const groupRank = new Map<string, number | null>();
  for (const f of found) {
    const home = homeOf.get(f.task.id) ?? null;
    if (!home) continue;
    const r = groupRank.get(home);
    groupRank.set(home, r === undefined ? f.rank : r === f.rank ? r : null);
  }
  const entries: PlanEntry[] = found.map((f) => {
    const home = homeOf.get(f.task.id) ?? null;
    const folderId = home && groupRank.get(home) === f.rank ? home : null;
    return { taskId: f.task.id, title: f.task.title, rank: f.rank, folderId };
  });
  return { savedAt, entries };
}

/** The list a period showed, with task ids: a slot's own list when there is one, else matched by title. */
export function periodList(
  p: PriorityPeriod,
  slots: readonly PrioritySlot[],
  tasks: readonly TaskLike[],
  homeOf: ReadonlyMap<string, string | null>,
): PlanList {
  const slot = p.slotId ? slots.find((s) => s.id === p.slotId) : undefined;
  if (slot && (p.kind === "slot" || p.kind === "scheduled")) {
    const same =
      slot.list.entries.length === p.titles.length && slot.list.entries.every((e, i) => e.title === p.titles[i]);
    if (same) return slot.list;
  }
  if (slot?.restore && p.kind === "back") return slot.restore;
  return listFromTitles(p.titles, p.ranks, tasks, homeOf, p.fromMs);
}
