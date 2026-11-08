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
  fitsInDay,
  formatSeconds,
  isValidDay,
  parseSecondsInput,
  rankAt,
  rankForTop,
  sumSeconds,
  uuidv7,
  type Change,
  type Day,
  type DayPart,
  type LogEntry,
  type NewChange,
  type Task,
} from "@pm/shared";
import { applyChangeLocally } from "./apply-change.ts";
import { ValidationError } from "./errors.ts";
import type { LocalStore, LocalTx, SyncTrigger } from "./ports.ts";
import { sortedRanks } from "./views.ts";

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
  async create(input: NewTaskInput): Promise<Task> {
    const description = input.description?.trim() ? input.description.trim() : null;
    const dueDate = input.dueDate?.trim() ? input.dueDate.trim() : null;
    const parsed = TaskSchema.safeParse({ id: uuidv7(), title: input.title, description, dueDate });
    if (!parsed.success) throw new ValidationError(taskError(input.title, description, dueDate));
    const task = parsed.data;

    await this.deps.store.write(async (tx) => {
      const rank = rankForTop(sortedRanks(await tx.listPlacements()));
      await record(tx, { op: "createTask", task, rank });
    });
    this.deps.sync.requestSync();
    return task;
  }

  /** Hard delete. Past log entries keep their copied title and are untouched. */
  async remove(taskId: string): Promise<void> {
    await this.deps.store.write((tx) => record(tx, { op: "deleteTask", taskId }));
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

export class PriorityActions {
  private readonly deps: Deps;
  constructor(deps: Deps) {
    this.deps = deps;
  }

  /**
   * Drop `taskId` so it ends up at `toIndex` of the list. Only this card's
   * rank changes; nothing else is renumbered.
   */
  async move(taskId: string, toIndex: number): Promise<void> {
    const moved = await this.deps.store.write(async (tx) => {
      const all = await tx.listPlacements();
      if (!all.some((p) => p.taskId === taskId)) return false;
      const others = sortedRanks(all.filter((p) => p.taskId !== taskId));
      const rank = rankAt(others, Math.max(0, Math.min(toIndex, others.length)));
      await record(tx, { op: "moveTask", taskId, rank });
      return true;
    });
    if (moved) this.deps.sync.requestSync();
  }
}

// ───────────── LOG ─────────────

export type AddLogResult = { ok: true; entry: LogEntry } | { ok: false; error: string };
export type AddSpanResult = { ok: true; entries: LogEntry[] } | { ok: false; error: string };

export class LogActions {
  private readonly deps: Deps;
  constructor(deps: Deps) {
    this.deps = deps;
  }

  /**
   * Record `seconds` (number or text like "8*60*60") against a task title on
   * `day`. The ONE rule: refused if the day would exceed 24 hours.
   */
  async add(day: Day, seconds: number | string, taskTitle: string): Promise<AddLogResult> {
    if (!isValidDay(day)) return { ok: false, error: "Invalid day" };
    const parsed = typeof seconds === "number" ? parseSecondsInput(String(seconds)) : parseSecondsInput(seconds);
    if (!parsed.ok) return parsed;
    const title = taskTitle.trim();
    if (!title) return { ok: false, error: "Pick a task" };
    const purged = await this.deps.store.purgedBefore();
    if (purged && day < purged) return { ok: false, error: `Logs before ${purged} were deleted` };

    const result = await this.deps.store.write(async (tx): Promise<AddLogResult> => {
      const total = sumSeconds(await tx.listLogsForDay(day));
      if (!fitsInDay(total, parsed.seconds)) {
        const left = 86_400 - total;
        return { ok: false, error: `Over 24 hours: only ${left.toLocaleString()} s (${formatSeconds(left)}) left on this day` };
      }
      const entry: LogEntry = { id: uuidv7(), day, seconds: parsed.seconds, taskTitle: title.slice(0, LIMITS.titleMax) };
      await record(tx, { op: "createLog", entry });
      return { ok: true, entry };
    });
    if (result.ok) this.deps.sync.requestSync();
    return result;
  }

  /**
   * Record one span of time that may cover several days (from splitByDay):
   * one log row per day, all under the same title, all-or-nothing. The same
   * rules as add() apply to EVERY day; if any day fails, nothing is saved.
   */
  async addSpan(parts: readonly DayPart[], taskTitle: string): Promise<AddSpanResult> {
    const title = taskTitle.trim().slice(0, LIMITS.titleMax);
    if (!title) return { ok: false, error: "Type what you did" };
    const real = parts.filter((p) => p.seconds >= 1);
    if (real.length === 0) return { ok: false, error: "Less than a second to log" };
    for (const p of real) {
      if (!isValidDay(p.day)) return { ok: false, error: "Invalid day" };
      if (!Number.isInteger(p.seconds) || p.seconds > 86_400) return { ok: false, error: "Invalid duration" };
    }
    const purged = await this.deps.store.purgedBefore();
    const old = purged ? real.find((p) => p.day < purged) : undefined;
    if (old) return { ok: false, error: `Logs before ${purged} were deleted` };

    const result = await this.deps.store.write(async (tx): Promise<AddSpanResult> => {
      for (const p of real) {
        const total = sumSeconds(await tx.listLogsForDay(p.day));
        if (!fitsInDay(total, p.seconds)) {
          const left = 86_400 - total;
          return { ok: false, error: `Over 24 hours on ${p.day}: only ${formatSeconds(left)} left` };
        }
      }
      const entries: LogEntry[] = [];
      for (const p of real) {
        const entry: LogEntry = { id: uuidv7(), day: p.day, seconds: p.seconds, taskTitle: title };
        await record(tx, { op: "createLog", entry });
        entries.push(entry);
      }
      return { ok: true, entries };
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
