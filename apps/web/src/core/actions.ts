/**
 * Client use cases. Each user action:
 *   1. builds ONE Change (the same message the server understands),
 *   2. in one local transaction: appends it to the outbox AND applies it to
 *      the local copy (so the UI updates instantly, even offline),
 *   3. asks for a sync.
 */
import {
  DaySchema,
  LIMITS,
  TaskSchema,
  dayBounds,
  formatSeconds,
  isValidDay,
  logSpan,
  parseActivity,
  parseSecondsInput,
  rankAt,
  rankForTop,
  splitByDay,
  uuidv7,
  type Change,
  type Day,
  type LogEntry,
  type NewChange,
  type Task,
} from "@pm/shared";
import { applyChangeLocally } from "./apply-change.ts";
import { ValidationError } from "./errors.ts";
import type { LocalStore, LocalTx, SyncTrigger } from "./ports.ts";
import { dayLayout, firstFit, fitsInFree, longestGap } from "./timeline.ts";
import { priorityOrder, scoringOrder, sortedRanks } from "./views.ts";

async function record(tx: LocalTx, c: NewChange): Promise<Change> {
  const change = { changeId: uuidv7(), ...c } as Change;
  await tx.enqueue(change);
  await applyChangeLocally(tx, change);
  return change;
}

interface Deps {
  store: LocalStore;
  sync: SyncTrigger;
}

const sameTitles = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * PRIORITY HISTORY: if the scoring order (top task, queue, rest) differs from
 * the latest snapshot, append one taken at `now`. Called in the same
 * transaction as every change that can reorder it. Returns true if recorded.
 */
async function recordHistory(tx: LocalTx, now: number): Promise<boolean> {
  const titles = scoringOrder(await tx.listTasks(), await tx.listPlacements()).map((t) => t.title);
  const latest = (await tx.listHistory()).at(-1);
  if (latest ? sameTitles(latest.titles, titles) : titles.length === 0) return false;
  // Strictly after the latest one, so two changes in the same millisecond keep their order.
  const at = latest ? Math.max(now, latest.at + 1) : now;
  await record(tx, { op: "recordPriority", snapshot: { id: uuidv7(at), at, titles } });
  return true;
}

// ───────────── TASKS ─────────────

export interface NewTaskInput {
  title: string;
  description?: string | null;
  dueDate?: string | null;
}

export class TaskActions {
  private readonly deps: Deps;
  constructor(deps: Deps) {
    this.deps = deps;
  }

  /** New tasks always go to the TOP of the priority list. */
  async create(input: NewTaskInput, now = Date.now()): Promise<Task> {
    // ";" ends an activity in a log, so a title cannot contain one.
    if (input.title.includes(";")) throw new ValidationError("A title cannot contain ';'");
    const description = input.description?.trim() ? input.description.trim() : null;
    const dueDate = input.dueDate?.trim() ? input.dueDate.trim() : null;
    const parsed = TaskSchema.safeParse({ id: uuidv7(), title: input.title, description, dueDate });
    if (!parsed.success) throw new ValidationError(taskError(input.title, description, dueDate));
    const task = parsed.data;

    await this.deps.store.write(async (tx) => {
      const rank = rankForTop(sortedRanks(await tx.listPlacements()));
      await record(tx, { op: "createTask", task, rank });
      await recordHistory(tx, now);
    });
    this.deps.sync.requestSync();
    return task;
  }

  /**
   * Hard delete (also how a task leaves the WAITING QUEUE). Past log entries
   * keep their copied title and are untouched.
   */
  async remove(taskId: string, now = Date.now()): Promise<void> {
    await this.deps.store.write(async (tx) => {
      await record(tx, { op: "deleteTask", taskId });
      await recordHistory(tx, now);
    });
    this.deps.sync.requestSync();
  }
}

function taskError(title: string, description: string | null, dueDate: string | null): string {
  if (!title.trim()) return "Title is required";
  if (title.trim().length > LIMITS.titleMax) return `Title must be at most ${LIMITS.titleMax} characters`;
  if (description && description.length > LIMITS.descriptionMax)
    return `Description must be at most ${LIMITS.descriptionMax} characters`;
  if (dueDate && !isValidDay(dueDate)) return "Due date must be a real date";
  return "Invalid task";
}

// ───────────── PRIORITY ─────────────

/**
 * Rank that puts `taskId` at `toIndex` of the VISIBLE list (queued tasks are
 * not in it; the task itself is left out first). Null if it has no placement.
 */
async function rankInVisible(tx: LocalTx, taskId: string, toIndex: number): Promise<string | null> {
  const tasks = await tx.listTasks();
  const all = await tx.listPlacements();
  if (!all.some((p) => p.taskId === taskId)) return null;
  const visible = priorityOrder(
    tasks,
    all.filter((p) => p.taskId !== taskId && (p.queuedAt === null || p.queuedAt === undefined)),
  );
  const rankOf = new Map(all.map((p) => [p.taskId, p.rank]));
  const index = Math.max(0, Math.min(toIndex, visible.length));
  const after = index < visible.length ? rankOf.get(visible[index]!.id)! : null;
  // Right before the next visible card, in the full rank order (or at the end).
  const ranks = sortedRanks(all.filter((p) => p.taskId !== taskId));
  return rankAt(ranks, after === null ? ranks.length : ranks.indexOf(after));
}

export class PriorityActions {
  private readonly deps: Deps;
  constructor(deps: Deps) {
    this.deps = deps;
  }

  /**
   * Drop `taskId` so it ends up at `toIndex` of the list. Only this card's
   * rank changes; nothing else is renumbered.
   */
  async move(taskId: string, toIndex: number, now = Date.now()): Promise<void> {
    const moved = await this.deps.store.write(async (tx) => {
      const rank = await rankInVisible(tx, taskId, toIndex);
      if (rank === null) return false;
      await record(tx, { op: "moveTask", taskId, rank });
      await recordHistory(tx, now);
      return true;
    });
    if (moved) this.deps.sync.requestSync();
  }

  /**
   * Pull a task out of the WAITING QUEUE (the bottom one, first in): it goes
   * back into the visible list SECOND, right under the top task (or on top
   * if the list is empty). Queued again later, it waits from zero.
   */
  async dequeue(taskId: string, now = Date.now()): Promise<void> {
    const done = await this.deps.store.write(async (tx) => {
      const p = await tx.getPlacement(taskId);
      if (!p || p.queuedAt === null || p.queuedAt === undefined) return false;
      const rank = await rankInVisible(tx, taskId, 1);
      if (rank === null) return false;
      await record(tx, { op: "dequeueTask", taskId, rank });
      await recordHistory(tx, now);
      return true;
    });
    if (done) this.deps.sync.requestSync();
  }

  /** Drop a task into the WAITING QUEUE: it leaves the visible list and starts waiting from `now`. */
  async enqueue(taskId: string, now = Date.now()): Promise<void> {
    const queued = await this.deps.store.write(async (tx) => {
      const p = await tx.getPlacement(taskId);
      if (!p || (p.queuedAt !== null && p.queuedAt !== undefined)) return false;
      await record(tx, { op: "queueTask", taskId, queuedAt: now });
      await recordHistory(tx, now);
      return true;
    });
    if (queued) this.deps.sync.requestSync();
  }

  /**
   * Make sure the PRIORITY HISTORY ends with the current scoring order (first
   * run after the update, or an order changed by an older device). Call after
   * a sync, so the local copy is up to date.
   */
  async reconcileHistory(now = Date.now()): Promise<void> {
    if (await this.deps.store.write((tx) => recordHistory(tx, now))) this.deps.sync.requestSync();
  }
}

// ───────────── LOG ─────────────

export type AddLogResult = { ok: true; entry: LogEntry } | { ok: false; error: string };
export type ProposeResult = { ok: true; seconds: number; startMs: number; endMs: number } | { ok: false; error: string };

/** Refusals shared by `propose` and `add`. */
function placeIn(
  free: ReturnType<typeof dayLayout>["free"],
  seconds: number,
): { ok: true; startMs: number } | { ok: false; error: string } {
  const start = firstFit(free, seconds);
  if (start !== null) return { ok: true, startMs: start };
  const longest = longestGap(free);
  if (longest === 0) return { ok: false, error: "No free time left on this day: remove a log first" };
  return {
    ok: false,
    error: `No free slot of ${formatSeconds(seconds)}: the longest is ${formatSeconds(longest)}. Remove a log first`,
  };
}

export class LogActions {
  private readonly deps: Deps;
  constructor(deps: Deps) {
    this.deps = deps;
  }

  private async check(day: Day, seconds: number | string, taskTitle: string) {
    if (!isValidDay(day)) return { ok: false as const, error: "Invalid day" };
    const parsed = parseSecondsInput(String(seconds));
    if (!parsed.ok) return parsed;
    const activity = parseActivity(taskTitle, [taskTitle.trim()]);
    if (!activity.ok) return { ok: false as const, error: activity.error === "Type what you did" ? "Pick a task" : activity.error };
    const purged = await this.deps.store.purgedBefore();
    if (purged && day < purged) return { ok: false as const, error: `Logs before ${purged} were deleted` };
    return { ok: true as const, seconds: parsed.seconds, title: activity.activity.slice(0, LIMITS.titleMax) };
  }

  /**
   * Where a manual log of `seconds` would go on `day`: the start of the
   * earliest free gap that holds it whole. Free = not covered by another log
   * or by the running TIMER. Nothing is saved; the user accepts first.
   */
  async propose(day: Day, seconds: number | string, taskTitle = "x"): Promise<ProposeResult> {
    const c = await this.check(day, seconds, taskTitle);
    if (!c.ok) return c;
    const layout = dayLayout(day, await this.deps.store.listLogsForDay(day), await this.deps.store.timerStart());
    const placed = placeIn(layout.free, c.seconds);
    if (!placed.ok) return placed;
    return { ok: true, seconds: c.seconds, startMs: placed.startMs, endMs: placed.startMs + c.seconds * 1000 };
  }

  /**
   * Record a MANUAL log of `seconds` (number or text like "8*60*60") for one
   * task on `day`, at `startMs` (the accepted proposal) or, if omitted, at the
   * earliest free gap. Refused if that time is not free any more.
   */
  async add(day: Day, seconds: number | string, taskTitle: string, startMs?: number): Promise<AddLogResult> {
    const c = await this.check(day, seconds, taskTitle);
    if (!c.ok) return c;

    const result = await this.deps.store.write(async (tx): Promise<AddLogResult> => {
      const { free } = dayLayout(day, await tx.listLogsForDay(day), await tx.getTimerStart());
      let start: number;
      if (startMs === undefined) {
        const placed = placeIn(free, c.seconds);
        if (!placed.ok) return placed;
        start = placed.startMs;
      } else {
        const bounds = dayBounds(day);
        if (startMs < bounds.start || !fitsInFree(free, logSpan(startMs, c.seconds))) {
          return { ok: false, error: "That time is no longer free: try again" };
        }
        start = startMs;
      }
      const entry: LogEntry = {
        id: uuidv7(),
        day,
        seconds: c.seconds,
        taskTitle: c.title,
        focus: null,
        deviation: null,
        startMs: start,
        source: "manual",
      };
      await record(tx, { op: "createLog", entry });
      return { ok: true, entry };
    });
    if (result.ok) this.deps.sync.requestSync();
    return result;
  }

  async remove(logId: string): Promise<void> {
    await this.deps.store.write((tx) => record(tx, { op: "deleteLog", logId }));
    this.deps.sync.requestSync();
  }

  /** Hard-delete every log entry dated before `day` (on all devices). */
  async purgeBefore(day: Day): Promise<void> {
    const before = DaySchema.safeParse(day);
    if (!before.success) throw new ValidationError("Pick a valid date");
    await this.deps.store.write((tx) => record(tx, { op: "purgeLogsBefore", before: before.data }));
    this.deps.sync.requestSync();
  }
}

// ───────────── TIMER ─────────────

export type TimerLogResult = { ok: true; entries: LogEntry[] } | { ok: false; error: string };

/**
 * ONE TIMER shared by every device: its start is synced (the latest restart
 * wins). ✓ saves the logs AND restarts the count in ONE local transaction:
 * both happen or neither does.
 */
export class TimerActions {
  private readonly deps: Deps;
  constructor(deps: Deps) {
    this.deps = deps;
  }

  /**
   * Make sure a start exists and return it. `legacy` is a start kept by an
   * older version (outside the store); it is adopted once, if the store has
   * none. A start made up here is provisional: the shared one from the
   * server replaces it on the next sync.
   */
  async ensureStart(legacy: number | null, now = Date.now()): Promise<number> {
    const existing = await this.deps.store.timerStart();
    if (existing !== null) return existing;
    const start = await this.deps.store.write(async (tx) => {
      const current = await tx.getTimerStart();
      if (current !== null) return current;
      await tx.setTimerStart(legacy ?? now, legacy === null);
      return legacy ?? now;
    });
    this.deps.sync.requestSync();
    return start;
  }

  /** ✕: log nothing, count from `now` (on every device). */
  async restart(now = Date.now()): Promise<void> {
    await this.deps.store.write((tx) => record(tx, { op: "setTimerStart", startMs: now }));
    this.deps.sync.requestSync();
  }

  /**
   * ✓: log [start, now) as ONE activity (`text` is "Activity;", the ";" may
   * be left out), one row per day (split at local midnight), each placed on
   * the clock, and restart the count at `now`, all in one transaction. The
   * start is read INSIDE the transaction, so the same span is never logged
   * twice from one device. Scores are worked out later from the logs.
   */
  async logAndRestart(text: string, now = Date.now()): Promise<TimerLogResult> {
    const result = await this.deps.store.write(async (tx): Promise<TimerLogResult> => {
      const titles = (await tx.listTasks()).map((t) => t.title);
      const activity = parseActivity(text, titles);
      if (!activity.ok) return activity;
      const start = (await tx.getTimerStart()) ?? now;
      const parts = splitByDay(start, now);
      if (parts.length === 0) return { ok: false, error: "Less than a second to log" };
      const purged = await tx.getPurgedBefore();
      if (purged && parts.some((p) => p.day < purged)) return { ok: false, error: `Logs before ${purged} were deleted` };
      const entries: LogEntry[] = [];
      for (const p of parts) {
        const entry: LogEntry = {
          id: uuidv7(now),
          day: p.day,
          seconds: p.seconds,
          taskTitle: activity.activity.slice(0, LIMITS.titleMax),
          focus: null,
          deviation: null,
          startMs: p.startMs,
          source: "timer",
        };
        await record(tx, { op: "createLog", entry });
        entries.push(entry);
      }
      await record(tx, { op: "setTimerStart", startMs: now });
      return { ok: true, entries };
    });
    if (result.ok) this.deps.sync.requestSync();
    return result;
  }
}
