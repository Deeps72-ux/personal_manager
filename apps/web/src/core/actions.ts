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
  activityKey,
  TaskSchema,
  dayBounds,
  formatSeconds,
  isValidDay,
  logSpan,
  parseActivity,
  parseSecondsInput,
  latestConfirmed,
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
import { buildFolderTree, nameKey, type FolderId, type FolderTree } from "./folders.ts";
import { ValidationError } from "./errors.ts";
import type { LocalStore, LocalTx, SyncTrigger } from "./ports.ts";
import { piecesToLog, singleSegment, type LoggedPiece, type Segment } from "./split.ts";
import { dayLayout, fitsInFree } from "./timeline.ts";
import { canConfirm, priorityOrder, sortedRanks, visibleTitles } from "./views.ts";

async function record(tx: LocalTx, c: NewChange): Promise<Change> {
  const change = { changeId: uuidv7(), ...c } as Change;
  await tx.enqueue(change);
  await applyChangeLocally(tx, change);
  return change;
}

/** Two logs at most this far apart (end → start) touch. Timer logs end on a whole second. */
const ADJACENT_MS = 1000;

/**
 * Write `entry`, merged with every log of the same activity on its day that
 * touches it (end to start, at most a second apart): those are deleted and one
 * log covering them all is created. Returns what was written.
 */
async function createLogMerged(tx: LocalTx, entry: LogEntry): Promise<LogEntry> {
  if (entry.startMs == null) {
    await record(tx, { op: "createLog", entry });
    return entry;
  }
  const key = activityKey(entry.taskTitle);
  const same = (await tx.listLogsForDay(entry.day)).filter(
    (l) => l.id !== entry.id && l.startMs != null && activityKey(l.taskTitle) === key,
  );
  let start = entry.startMs;
  let end = entry.startMs + entry.seconds * 1000;
  const absorbed: LogEntry[] = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const l of same) {
      if (absorbed.includes(l)) continue;
      const ls = l.startMs!;
      const le = ls + l.seconds * 1000;
      if (le < start - ADJACENT_MS || ls > end + ADJACENT_MS) continue;
      if (le > start + ADJACENT_MS && ls < end - ADJACENT_MS) continue; // overlapping: not ours to touch
      absorbed.push(l);
      start = Math.min(start, ls);
      end = Math.max(end, le);
      grew = true;
    }
  }
  if (absorbed.length === 0) {
    await record(tx, { op: "createLog", entry });
    return entry;
  }
  for (const l of absorbed) await record(tx, { op: "deleteLog", logId: l.id });
  const first = [entry, ...absorbed].sort((a, b) => a.startMs! - b.startMs!)[0]!;
  const merged: LogEntry = { ...entry, taskTitle: first.taskTitle, startMs: start, seconds: Math.floor((end - start) / 1000) };
  await record(tx, { op: "createLog", entry: merged });
  return merged;
}

interface Deps {
  store: LocalStore;
  sync: SyncTrigger;
}

/**
 * PRIORITY HISTORY: a CONFIRMED snapshot of the visible list (never the
 * queue), taken at `now`, when it differs from the latest confirmed one.
 * Only the confirm icon calls this: reordering, adding, deleting, queuing
 * and un-queuing never score until confirmed. Returns true if recorded.
 */
async function recordConfirmed(tx: LocalTx, now: number): Promise<boolean> {
  const titles = visibleTitles(await tx.listTasks(), await tx.listPlacements());
  const history = await tx.listHistory();
  if (!canConfirm(titles, latestConfirmed(history))) return false;
  // Strictly after the latest snapshot, so two in the same millisecond keep their order.
  const last = history.at(-1);
  const at = last ? Math.max(now, last.at + 1) : now;
  await record(tx, { op: "recordPriority", snapshot: { id: uuidv7(at), at, titles, confirmed: true } });
  return true;
}

// ───────────── TASKS ─────────────

export interface NewTaskInput {
  title: string;
  description?: string | null;
  dueDate?: string | null;
  /** TASKS-tab folder to create it in (null or gone = top level). */
  folderId?: string | null;
}

export class TaskActions {
  private readonly deps: Deps;
  constructor(deps: Deps) {
    this.deps = deps;
  }

  /**
   * New tasks always go to the TOP of the priority list, and to the BOTTOM
   * of their folder in the TASKS tab.
   */
  async create(input: NewTaskInput): Promise<Task> {
    // ";" ends an activity in a log, so a title cannot contain one.
    if (input.title.includes(";")) throw new ValidationError("A title cannot contain ';'");
    const description = input.description?.trim() ? input.description.trim() : null;
    const dueDate = input.dueDate?.trim() ? input.dueDate.trim() : null;
    const parsed = TaskSchema.safeParse({ id: uuidv7(), title: input.title, description, dueDate });
    if (!parsed.success) throw new ValidationError(taskError(input.title, description, dueDate));

    const task = await this.deps.store.write(async (tx) => {
      const placements = await tx.listPlacements();
      const tree = await treeIn(tx);
      const folderId = input.folderId && tree.has(input.folderId) ? input.folderId : null;
      const task: Task = { ...parsed.data, folderId, folderRank: taskRankAt(tree, folderId, null) };
      await record(tx, { op: "createTask", task, rank: rankForTop(sortedRanks(placements)) });
      return task;
    });
    this.deps.sync.requestSync();
    return task;
  }

  /**
   * Hard delete (also how a task leaves the WAITING QUEUE). Past log entries
   * keep their copied title and are untouched.
   */
  async remove(taskId: string): Promise<void> {
    await this.deps.store.write(async (tx) => {
      await record(tx, { op: "deleteTask", taskId });
    });
    this.deps.sync.requestSync();
  }
}

// ───────────── TASKS tab folders ─────────────

async function treeIn(tx: LocalTx): Promise<FolderTree> {
  return buildFolderTree(await tx.listFolders(), await tx.listTasks(), await tx.listPlacements());
}

/** Order key that puts a task at `index` of `folderId`'s tasks (`taskId` left out first). Default: the bottom. */
function taskRankAt(tree: FolderTree, folderId: FolderId, taskId: string | null, index?: number): string {
  const keys = tree
    .tasks(folderId)
    .filter((t) => t.id !== taskId)
    .map(tree.taskKey);
  return rankAt(keys, clampIndex(index, keys.length));
}

/** Rank that puts a folder at `index` of `parentId`'s sub-folders (`folderId` left out first). Default: the bottom. */
function folderRankAt(tree: FolderTree, parentId: FolderId, folderId: string | null, index?: number): string {
  const ranks = tree
    .folders(parentId)
    .filter((f) => f.id !== folderId)
    .map((f) => f.rank);
  return rankAt(ranks, clampIndex(index, ranks.length));
}

const clampIndex = (index: number | undefined, length: number) =>
  index === undefined ? length : Math.max(0, Math.min(Math.trunc(index), length));

/** A trimmed, valid folder name not used by another folder in `parentId`, or throws. */
function checkName(tree: FolderTree, parentId: FolderId, name: string, self: string | null): string {
  const trimmed = name.trim();
  if (!trimmed) throw new ValidationError("Folder name is required");
  if (trimmed.length > LIMITS.titleMax) throw new ValidationError(`Folder name must be at most ${LIMITS.titleMax} characters`);
  if (tree.folders(parentId).some((f) => f.id !== self && nameKey(f.name) === nameKey(trimmed))) {
    throw new ValidationError(`There is already a folder called "${trimmed}" here`);
  }
  return trimmed;
}

/**
 * FOLDERS in the TASKS tab: create, rename, move, remove, and moving tasks
 * between them. Folders only shape the TASKS tab: moving things never
 * changes priority, the queue or logs.
 */
export class FolderActions {
  private readonly deps: Deps;
  constructor(deps: Deps) {
    this.deps = deps;
  }

  /** New folder at the BOTTOM of `parentId`'s folders. Names are unique among siblings (ignoring case). */
  async create(name: string, parentId: FolderId = null): Promise<string> {
    const id = await this.deps.store.write(async (tx) => {
      const tree = await treeIn(tx);
      const parent = parentId && tree.has(parentId) ? parentId : null;
      const folder = { id: uuidv7(), name: checkName(tree, parent, name, null), parentId: parent, rank: folderRankAt(tree, parent, null) };
      await record(tx, { op: "createFolder", folder });
      return folder.id;
    });
    this.deps.sync.requestSync();
    return id;
  }

  async rename(folderId: string, name: string): Promise<void> {
    const changed = await this.deps.store.write(async (tx) => {
      const tree = await treeIn(tx);
      const folder = tree.get(folderId);
      if (!folder) return false;
      const trimmed = checkName(tree, tree.parentOf(folderId), name, folderId);
      if (trimmed === folder.name) return false;
      await record(tx, { op: "renameFolder", folderId, name: trimmed });
      return true;
    });
    if (changed) this.deps.sync.requestSync();
  }

  /**
   * Hard delete of the folder, its sub-folders and EVERY task inside them
   * (each task removed exactly like TASKS ✕: it leaves priority and the
   * queue; past logs are untouched).
   */
  async remove(folderId: string): Promise<void> {
    const removed = await this.deps.store.write(async (tx) => {
      const tree = await treeIn(tx);
      if (!tree.has(folderId)) return false;
      const folders = [tree.get(folderId)!, ...tree.descendants(folderId)];
      for (const f of folders) for (const t of tree.tasks(f.id)) await record(tx, { op: "deleteTask", taskId: t.id });
      for (const f of folders.reverse()) await record(tx, { op: "deleteFolder", folderId: f.id });
      return true;
    });
    if (removed) this.deps.sync.requestSync();
  }

  /**
   * Move a folder into `parentId` (null = top level) at `index` of its
   * folders (default: the bottom). Refused into itself or one of its own
   * sub-folders, or next to a folder with the same name.
   */
  async moveFolder(folderId: string, parentId: FolderId, index?: number): Promise<void> {
    const moved = await this.deps.store.write(async (tx) => {
      const tree = await treeIn(tx);
      const folder = tree.get(folderId);
      if (!folder) return false;
      const parent = parentId && tree.has(parentId) ? parentId : null;
      if (tree.contains(folderId, parent)) throw new ValidationError("A folder cannot go inside itself");
      if (parent !== tree.parentOf(folderId)) checkName(tree, parent, folder.name, folderId);
      const rank = folderRankAt(tree, parent, folderId, index);
      if (parent === folder.parentId && rank === folder.rank) return false;
      await record(tx, { op: "moveFolder", folderId, parentId: parent, rank });
      return true;
    });
    if (moved) this.deps.sync.requestSync();
  }

  /** Move a task into `folderId` (null = top level) at `index` of its tasks (default: the bottom). */
  async moveTask(taskId: string, folderId: FolderId, index?: number): Promise<void> {
    const moved = await this.deps.store.write(async (tx) => {
      const tree = await treeIn(tx);
      const task = await tx.getTask(taskId);
      if (!task) return false;
      const target = folderId && tree.has(folderId) ? folderId : null;
      const folderRank = taskRankAt(tree, target, taskId, index);
      await record(tx, { op: "setTaskFolder", taskId, folderId: target, folderRank });
      return true;
    });
    if (moved) this.deps.sync.requestSync();
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
  async move(taskId: string, toIndex: number): Promise<void> {
    const moved = await this.deps.store.write(async (tx) => {
      const rank = await rankInVisible(tx, taskId, toIndex);
      if (rank === null) return false;
      await record(tx, { op: "moveTask", taskId, rank });
      return true;
    });
    if (moved) this.deps.sync.requestSync();
  }

  /**
   * Pull a task out of the WAITING QUEUE (the bottom one, first in): it goes
   * back into the visible list at the TOP (#1), so the last one pulled out
   * is on top. Queued again later, it waits from zero. Not scored until
   * the order is confirmed.
   */
  async dequeue(taskId: string): Promise<void> {
    const done = await this.deps.store.write(async (tx) => {
      const p = await tx.getPlacement(taskId);
      if (!p || p.queuedAt === null || p.queuedAt === undefined) return false;
      const rank = await rankInVisible(tx, taskId, 0);
      if (rank === null) return false;
      await record(tx, { op: "dequeueTask", taskId, rank });
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
      return true;
    });
    if (queued) this.deps.sync.requestSync();
  }

  /**
   * The confirm icon: snapshot the visible list as it is now, time-stamped
   * `now`. From then on, scores are taken against it. Does nothing (false)
   * when the list is empty or its order is the confirmed one already.
   */
  async confirm(now = Date.now()): Promise<boolean> {
    const done = await this.deps.store.write((tx) => recordConfirmed(tx, now));
    if (done) this.deps.sync.requestSync();
    return done;
  }

  /**
   * Upgrade from the versions that snapshotted every change: when there is
   * legacy history but nothing confirmed yet, confirm today's visible list
   * once, so a confirmed snapshot is always in force from here on. Legacy
   * snapshots never score (time before it is unscored). A new user (no history)
   * starts unscored until their first confirm. Call after a sync.
   */
  async ensureConfirmedStart(now = Date.now()): Promise<void> {
    const done = await this.deps.store.write(async (tx) => {
      const history = await tx.listHistory();
      if (history.length === 0 || latestConfirmed(history)) return false;
      return recordConfirmed(tx, now);
    });
    if (done) this.deps.sync.requestSync();
  }
}

// ───────────── LOG ─────────────

export type AddLogResult = { ok: true; entry: LogEntry } | { ok: false; error: string };
export type AddPiecesResult = { ok: true; entries: LogEntry[] } | { ok: false; error: string };

/**
 * MANUAL logs go exactly where the user puts them on the day's split bar:
 * there is no guessing. Time covered by another log or by the running TIMER
 * is never free.
 */
export class LogActions {
  private readonly deps: Deps;
  constructor(deps: Deps) {
    this.deps = deps;
  }

  /**
   * Save every labeled open piece of `day`'s split bar as a MANUAL log
   * (neighbours with the same activity become one), in one transaction:
   * all or nothing. Refused if any piece is outside the day or no longer free.
   */
  async addPieces(day: Day, segs: readonly Segment[]): Promise<AddPiecesResult> {
    if (!isValidDay(day)) return { ok: false, error: "Invalid day" };
    const result = await this.deps.store.write(async (tx): Promise<AddPiecesResult> => {
      const parsed = piecesToLog(segs, (await tx.listTasks()).map((t) => t.title));
      if (!parsed.ok) return { ok: false, error: parsed.error };
      if (parsed.pieces.length === 0) return { ok: false, error: "Label at least one piece to log it" };
      return this.writePieces(tx, day, parsed.pieces);
    });
    if (result.ok) this.deps.sync.requestSync();
    return result;
  }

  /**
   * One MANUAL log of `seconds` (number or text like "8*60*60") for one
   * activity on `day`, starting exactly at `startMs`.
   */
  async add(day: Day, seconds: number | string, taskTitle: string, startMs: number): Promise<AddLogResult> {
    if (!isValidDay(day)) return { ok: false, error: "Invalid day" };
    const secs = parseSecondsInput(String(seconds));
    if (!secs.ok) return secs;
    const activity = parseActivity(taskTitle, [taskTitle.trim()]);
    if (!activity.ok) return { ok: false, error: activity.error === "Type what you did" ? "Pick a task" : activity.error };
    const piece = { startMs, endMs: startMs + secs.seconds * 1000, activity: activity.activity };
    const result = await this.deps.store.write((tx) => this.writePieces(tx, day, [piece]));
    if (!result.ok) return result;
    this.deps.sync.requestSync();
    return { ok: true, entry: result.entries[0]! };
  }

  private async writePieces(tx: LocalTx, day: Day, pieces: readonly LoggedPiece[]): Promise<AddPiecesResult> {
    const purged = await tx.getPurgedBefore();
    if (purged && day < purged) return { ok: false, error: `Logs before ${purged} were deleted` };
    const bounds = dayBounds(day);
    const { free } = dayLayout(day, await tx.listLogsForDay(day), await tx.getTimerStart());
    for (const p of pieces) {
      if (p.startMs < bounds.start || p.endMs > bounds.end) return { ok: false, error: "A piece is outside this day" };
      if (p.endMs - p.startMs < 1000) return { ok: false, error: "A piece is shorter than a second" };
      if (!fitsInFree(free, { start: p.startMs, end: p.endMs })) {
        return { ok: false, error: "That time is no longer free: try again" };
      }
    }
    const entries: LogEntry[] = [];
    for (const p of pieces) {
      const entry: LogEntry = {
        id: uuidv7(),
        day,
        seconds: Math.floor((p.endMs - p.startMs) / 1000),
        taskTitle: p.activity.slice(0, LIMITS.titleMax),
        focus: null,
        deviation: null,
        startMs: p.startMs,
        source: "manual",
      };
      entries.push(await createLogMerged(tx, entry));
    }
    return { ok: true, entries };
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
   * be left out) and restart the count at `now`. See `logSegments`.
   */
  logAndRestart(text: string, now = Date.now()): Promise<TimerLogResult> {
    return this.save((start) => singleSegment(start, now, text), now);
  }

  /**
   * ✓ with the SPLIT BAR: `segs` cut [start, end) into pieces, each labeled
   * or unlogged; the last piece runs on until `now`. Labeled pieces are
   * logged (neighbours with the same activity become one), each split at
   * local midnight and placed on the clock; unlogged ones are dropped. The
   * count restarts at `now`, all in one transaction. Refused if another
   * device restarted the timer meanwhile (the bar would be stale).
   */
  logSegments(segs: readonly Segment[], now = Date.now()): Promise<TimerLogResult> {
    return this.save((start) => {
      if (segs.length === 0 || segs[0]!.start !== start) return null;
      return segs.map((s, i) => (i === segs.length - 1 ? { ...s, end: Math.max(s.end, now) } : s));
    }, now);
  }

  private async save(build: (start: number) => Segment[] | null, now: number): Promise<TimerLogResult> {
    const result = await this.deps.store.write(async (tx): Promise<TimerLogResult> => {
      const titles = (await tx.listTasks()).map((t) => t.title);
      // Read INSIDE the transaction, so the same span is never logged twice from one device.
      const start = (await tx.getTimerStart()) ?? now;
      const segs = build(start);
      if (!segs) return { ok: false, error: "The timer was restarted meanwhile: check the pieces again" };
      if (segs.some((s) => s.end > now)) return { ok: false, error: "A piece is in the future" };
      const parsed = piecesToLog(segs, titles);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      if (parsed.pieces.length === 0) return { ok: false, error: "Type what you did" };
      const parts = parsed.pieces.flatMap((p) => splitByDay(p.startMs, p.endMs).map((d) => ({ ...d, activity: p.activity })));
      if (parts.length === 0) return { ok: false, error: "Less than a second to log" };
      const purged = await tx.getPurgedBefore();
      if (purged && parts.some((p) => p.day < purged)) return { ok: false, error: `Logs before ${purged} were deleted` };
      const entries: LogEntry[] = [];
      for (const p of parts) {
        const entry: LogEntry = {
          id: uuidv7(now),
          day: p.day,
          seconds: p.seconds,
          taskTitle: p.activity.slice(0, LIMITS.titleMax),
          focus: null,
          deviation: null,
          startMs: p.startMs,
          source: "timer",
        };
        entries.push(await createLogMerged(tx, entry));
      }
      await record(tx, { op: "setTimerStart", startMs: now });
      return { ok: true, entries };
    });
    if (result.ok) this.deps.sync.requestSync();
    return result;
  }
}
