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
  MAX_PRIORITY_RANK,
  activityKey,
  TaskSchema,
  dayBounds,
  formatSeconds,
  isValidDay,
  logSpan,
  parseActivity,
  parseSecondsInput,
  effectiveHistory,
  inForceAt,
  latestConfirmed,
  rankAt,
  rankForTop,
  splitByDay,
  uuidv7,
  uuidv7Time,
  type Change,
  type Day,
  type LogEntry,
  type NewChange,
  type PlanEntry,
  type PlanList,
  type PrioritySlot,
  type Task,
} from "@pm/shared";
import { applyChangeLocally } from "./apply-change.ts";
import { buildFolderTree, nameKey, type FolderId, type FolderTree } from "./folders.ts";
import { ValidationError } from "./errors.ts";
import type { LocalStore, LocalTx, SyncTrigger } from "./ports.ts";
import { piecesToLog, singleSegment, type LoggedPiece, type Segment } from "./split.ts";
import { dayLayout, fitsInFree } from "./timeline.ts";
import {
  canConfirm,
  closeUpRanks,
  dropCard,
  isQueued,
  planEntries,
  priorityOrder,
  rankedList,
  sortedRanks,
  visibleOrder,
  type RankedCard,
} from "./views.ts";

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
  const { titles, ranks } = visibleOrder(await tx.listTasks(), await tx.listPlacements(), await tx.listFolders());
  const history = await tx.listHistory();
  // Against the order in force NOW (a scheduled slot's list, during it).
  if (!canConfirm({ titles, ranks }, inForceAt(effectiveHistory(history, await tx.listSlots()), now))) return false;
  // Strictly after the latest snapshot, so two in the same millisecond keep their order.
  const last = history.at(-1);
  const at = last ? Math.max(now, last.at + 1) : now;
  await record(tx, { op: "recordPriority", snapshot: { id: uuidv7(at), at, titles, ranks, confirmed: true } });
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
   * New tasks always go to the TOP of the priority list, and to the very
   * TOP of their folder in the TASKS tab (its recent area, above the folders).
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
      const task: Task = { ...parsed.data, folderId, folderRank: rankFor(tree, folderId, "task", null, TOP), folderTop: true };
      const before = await rankedIn(tx);
      await record(tx, { op: "createTask", task, rank: rankForTop(sortedRanks(placements)) });
      // A new task erases typed ranks: positions become the list as it was shown, with it on top.
      await eraseCardRanks(tx, [task.id, ...before.map((c) => c.task.id)]);
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

/**
 * Where an item goes in a folder's list: in the recent area (`top`, mixed
 * tasks and folders) or in its own block (folders or tasks), at `index` of
 * that part with the item itself left out (default: the end of that part).
 */
export interface Slot {
  top: boolean;
  index?: number;
}
/** The very top of a folder: where new and moved-in items go. */
export const TOP: Slot = { top: true, index: 0 };

/** Order key that puts an item of `kind` at `slot` of `parent` (`selfId` left out first). */
function rankFor(tree: FolderTree, parent: FolderId, kind: "task" | "folder", selfId: string | null, slot: Slot): string {
  const keys = tree
    .items(parent)
    .filter((e) => e.id !== selfId && (slot.top ? e.top : !e.top && e.kind === kind))
    .map((e) => e.key);
  return rankAt(keys, clampIndex(slot.index, keys.length));
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

  /** New folder at the very TOP of `parentId` (its recent area). Names are unique among siblings (ignoring case). */
  async create(name: string, parentId: FolderId = null): Promise<string> {
    const id = await this.deps.store.write(async (tx) => {
      const tree = await treeIn(tx);
      const parent = parentId && tree.has(parentId) ? parentId : null;
      const folder = { id: uuidv7(), name: checkName(tree, parent, name, null), parentId: parent, rank: rankFor(tree, parent, "folder", null, TOP), top: true };
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
   * Move a folder into `parentId` (null = top level) at `slot` (default: the
   * very top). Refused into itself or one of its own sub-folders, or next to
   * a folder with the same name.
   */
  async moveFolder(folderId: string, parentId: FolderId, slot: Slot = TOP): Promise<void> {
    const moved = await this.deps.store.write(async (tx) => {
      const tree = await treeIn(tx);
      const folder = tree.get(folderId);
      if (!folder) return false;
      const parent = parentId && tree.has(parentId) ? parentId : null;
      if (tree.contains(folderId, parent)) throw new ValidationError("A folder cannot go inside itself");
      if (parent !== tree.parentOf(folderId)) checkName(tree, parent, folder.name, folderId);
      const rank = rankFor(tree, parent, "folder", folderId, slot);
      if (parent === folder.parentId && rank === folder.rank && slot.top === !!folder.top) return false;
      await record(tx, { op: "moveFolder", folderId, parentId: parent, rank, top: slot.top });
      return true;
    });
    if (moved) this.deps.sync.requestSync();
  }

  /**
   * Give a folder a PRIORITY rank (1 up to the number of cards in the list),
   * or null to remove it. Every task inside it, at any depth, takes it.
   */
  async setPriority(folderId: string, rank: number | null): Promise<void> {
    const done = await this.deps.store.write(async (tx) => {
      const folder = await tx.getFolder(folderId);
      if (!folder) return false;
      if (rank !== null) checkRank(rank, (await rankedIn(tx)).length);
      if ((folder.priority ?? null) === rank) return false;
      await record(tx, { op: "setFolderPriority", folderId, priority: rank });
      return true;
    });
    if (done) this.deps.sync.requestSync();
  }

  /** Move a task into `folderId` (null = top level) at `slot` (default: the very top). */
  async moveTask(taskId: string, folderId: FolderId, slot: Slot = TOP): Promise<void> {
    const moved = await this.deps.store.write(async (tx) => {
      const tree = await treeIn(tx);
      const task = await tx.getTask(taskId);
      if (!task) return false;
      const target = folderId && tree.has(folderId) ? folderId : null;
      const folderRank = rankFor(tree, target, "task", taskId, slot);
      await record(tx, { op: "setTaskFolder", taskId, folderId: target, folderRank, folderTop: slot.top });
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

/** The visible PRIORITY list as shown, with each card's rank. */
async function rankedIn(tx: LocalTx): Promise<RankedCard[]> {
  const placements = (await tx.listPlacements()).filter((p) => !isQueued(p));
  return rankedList(await tx.listTasks(), placements, await tx.listFolders());
}

/**
 * A drag, the queue or a new task: every rank typed on a card is erased and
 * the list order becomes `ids` (the visible list, top first), so positions
 * are what the user sees. Folder ranks stay.
 */
async function eraseCardRanks(tx: LocalTx, ids: readonly string[]): Promise<void> {
  const placements = await tx.listPlacements();
  if (placements.some((p) => p.userRank !== null && p.userRank !== undefined)) await record(tx, { op: "clearTaskRanks" });
  const visible = placements.filter((p) => !isQueued(p));
  const current = priorityOrder(await tx.listTasks(), visible).map((t) => t.id);
  const wanted = ids.filter((id) => visible.some((p) => p.taskId === id));
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);
  if (same(current, wanted)) return;
  const keyOf = new Map(visible.map((p) => [p.taskId, p.rank]));
  // One card moved: only its key changes (two devices moving different cards never conflict).
  for (const x of wanted) {
    const others = wanted.filter((id) => id !== x);
    if (!same(current.filter((id) => id !== x), others)) continue;
    const all = sortedRanks(visible.filter((p) => p.taskId !== x));
    const next = others[wanted.indexOf(x)];
    const at = next === undefined ? all.length : all.indexOf(keyOf.get(next)!);
    await record(tx, { op: "moveTask", taskId: x, rank: rankAt(all, at) });
    return;
  }
  // Otherwise fresh keys in the wanted order (queued cards keep theirs: they are not in the list).
  const keys: string[] = [];
  for (const id of wanted) {
    const key = rankAt(keys, keys.length);
    keys.push(key);
    if (visible.find((p) => p.taskId === id)!.rank !== key) await record(tx, { op: "moveTask", taskId: id, rank: key });
  }
}

export class PriorityActions {
  private readonly deps: Deps;
  constructor(deps: Deps) {
    this.deps = deps;
  }

  /**
   * Drop `taskId` so it ends up at `toIndex` of the list as shown (see
   * `dropCard`). The dropped card beats what it was dropped above: a
   * folder's group dropped under it moves down a step, and so does
   * everything below (folder ranks included, in the TASKS tab too). Dropped
   * inside a tied group it shares their rank. Dropped among its own folder's
   * cards it only reorders them (or rejoins them, if it had left). A card
   * dragged out of its folder's group leaves it alone: the folder keeps its
   * rank. Ranks typed on cards are erased: positions become the new order.
   */
  async move(taskId: string, toIndex: number): Promise<void> {
    const moved = await this.deps.store.write(async (tx) => {
      const cards = await rankedIn(tx);
      const from = cards.findIndex((c) => c.task.id === taskId);
      if (from < 0) return false;
      const drop = dropCard(cards, from, toIndex);
      if (!drop) return false;
      const card = cards[from]!;
      if (drop.mode === "group" && card.source === "folder" && cards.some((c) => c !== card && c.folderId === card.folderId)) {
        // Among its own folder's cards: they swap their order keys, nothing else changes.
        const group = drop.order.filter((c) => c.source === "folder" && c.folderId === card.folderId);
        return reorderGroup(tx, group);
      }
      await writeList(tx, drop.order, drop.folderRanks);
      return true;
    });
    if (moved) this.deps.sync.requestSync();
  }

  /**
   * Type a rank on a card (1 up to the number of cards; ties allowed), or
   * null to go back to its position. The card moves to sit with its rank;
   * no other card is renumbered. A folder's rank still wins over it.
   */
  async setRank(taskId: string, rank: number | null): Promise<void> {
    const done = await this.deps.store.write(async (tx) => {
      const cards = await rankedIn(tx);
      const card = cards.find((c) => c.task.id === taskId);
      if (!card) return false;
      if (rank !== null) checkRank(rank, cards.length);
      const p = await tx.getPlacement(taskId);
      if ((p?.userRank ?? null) === rank) return false;
      await record(tx, { op: "setTaskRank", taskId, userRank: rank });
      return true;
    });
    if (done) this.deps.sync.requestSync();
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
      const before = await rankedIn(tx);
      const rank = await rankInVisible(tx, taskId, 0);
      if (rank === null) return false;
      await record(tx, { op: "dequeueTask", taskId, rank });
      await eraseCardRanks(tx, [taskId, ...before.map((c) => c.task.id)]);
      return true;
    });
    if (done) this.deps.sync.requestSync();
  }

  /** Drop a task into the WAITING QUEUE: it leaves the visible list and starts waiting from `now`. */
  async enqueue(taskId: string, now = Date.now()): Promise<void> {
    const queued = await this.deps.store.write(async (tx) => {
      const p = await tx.getPlacement(taskId);
      if (!p || (p.queuedAt !== null && p.queuedAt !== undefined)) return false;
      const before = await rankedIn(tx);
      await record(tx, { op: "queueTask", taskId, queuedAt: now });
      await eraseCardRanks(
        tx,
        before.filter((c) => c.task.id !== taskId).map((c) => c.task.id),
      );
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
   * SCHEDULED slots that started or ended (call after a sync and every few
   * seconds). A slot that started: the visible list becomes its list and is
   * confirmed from its start (a snapshot with the slot's id, so two devices
   * doing it record one); the list it replaced is kept on the slot. A slot
   * that ended: that list comes back (unless the next slot starts right
   * away: then it is kept for the end of that one). A slot that ended
   * before any device saw it start changes nothing (scores still use it).
   */
  async applyDueSlots(now = Date.now()): Promise<boolean> {
    const done = await this.deps.store.write(async (tx) => {
      const slots = await tx.listSlots();
      if (slots.length === 0) return false;
      const confirmedIds = new Set((await tx.listHistory()).map((h) => h.id));
      let carried: PlanList | null = null;
      let changed = false;
      for (const [k, slot] of slots.entries()) {
        if (slot.startMs > now) break;
        const started = confirmedIds.has(slot.id);
        const running = now < slot.endMs;
        if (running && !started) {
          const restore = carried ?? (await captureList(tx, now));
          carried = null;
          await applyList(tx, slot.list, now);
          const { titles, ranks } = visibleOrder(await tx.listTasks(), await tx.listPlacements(), await tx.listFolders());
          await record(tx, { op: "recordPriority", snapshot: { id: slot.id, at: slot.startMs, titles, ranks, confirmed: true } });
          await record(tx, { op: "saveSlot", slot: { ...slot, restore, restored: false } });
          changed = true;
        } else if (!running && started && !slot.restored) {
          const next = slots[k + 1];
          if (next && next.startMs <= now && now < next.endMs && !confirmedIds.has(next.id)) carried = slot.restore ?? null;
          else if (slot.restore) await applyList(tx, slot.restore, now);
          await record(tx, { op: "saveSlot", slot: { ...slot, restored: true } });
          changed = true;
        }
      }
      return changed;
    });
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

/**
 * Make the visible list exactly `order` (top first, each card with the rank
 * it should show): placement order, folder ranks (`folderRanks`), and for
 * every other card its own rank (a card shown apart from its ranked folder
 * gets `ownRank`; a rank that is not its position is typed on it).
 */
async function writeList(tx: LocalTx, order: readonly RankedCard[], folderRanks: ReadonlyMap<string, number>): Promise<void> {
  await eraseCardRanks(
    tx,
    order.map((c) => c.task.id),
  );
  for (const [folderId, rank] of folderRanks) {
    const f = await tx.getFolder(folderId);
    if (f && (f.priority ?? null) !== rank) await record(tx, { op: "setFolderPriority", folderId, priority: rank });
  }
  const now = new Map((await rankedIn(tx)).map((c) => [c.task.id, c]));
  for (const want of order) {
    const p = await tx.getPlacement(want.task.id);
    const have = now.get(want.task.id);
    if (!p || !have) continue;
    if (want.source === "folder" && want.folderId === have.homeFolderId) {
      if (p.ownRank) await record(tx, { op: "setTaskOwnRank", taskId: p.taskId, ownRank: false });
      continue;
    }
    const own = have.homeFolderId !== null;
    if (own !== !!p.ownRank) await record(tx, { op: "setTaskOwnRank", taskId: p.taskId, ownRank: own });
    if (want.rank !== have.position) await record(tx, { op: "setTaskRank", taskId: p.taskId, userRank: want.rank });
  }
}

/**
 * When a list is kept: `now`, or later than every task that exists (so only
 * tasks made after it count as new, even in the same millisecond).
 */
async function savedAtFor(tx: LocalTx, now: number): Promise<number> {
  return Math.max(now, ...(await tx.listTasks()).map((t) => uuidv7Time(t.id)));
}

/** The visible list as a list kept for later. */
async function captureList(tx: LocalTx, now: number): Promise<PlanList> {
  return { savedAt: await savedAtFor(tx, now), entries: planEntries(await rankedIn(tx)) };
}

/**
 * Make a kept list the visible one: tasks deleted since are dropped (the
 * ranks below close up), tasks made after it was kept go on top, its tasks
 * waiting in the queue come out, and visible tasks not in it are queued.
 */
async function applyList(tx: LocalTx, list: PlanList, now: number): Promise<void> {
  const tasks = await tx.listTasks();
  const placements = new Map((await tx.listPlacements()).map((p) => [p.taskId, p]));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const kept = list.entries.filter((e) => byId.has(e.taskId) && placements.has(e.taskId));
  const inList = new Set(kept.map((e) => e.taskId));
  const fresh = priorityOrder(tasks, [...placements.values()])
    .filter((t) => !inList.has(t.id) && uuidv7Time(t.id) > list.savedAt)
    .sort((a, b) => (a.id < b.id ? 1 : -1))
    .map((t): PlanEntry => ({ taskId: t.id, title: t.title, rank: 1, folderId: null }));
  const items = [...fresh, ...kept];
  const ranked = closeUpRanks(items, new Set(items.slice(0, fresh.length)));
  const ids = new Set(ranked.map((e) => e.taskId));

  for (const e of ranked) {
    const p = placements.get(e.taskId)!;
    if (!isQueued(p)) continue;
    const rank = await rankInVisible(tx, e.taskId, 0);
    if (rank !== null) await record(tx, { op: "dequeueTask", taskId: e.taskId, rank });
  }
  for (const p of placements.values()) {
    if (!isQueued(p) && !ids.has(p.taskId)) await record(tx, { op: "queueTask", taskId: p.taskId, queuedAt: now });
  }
  const folderRanks = new Map<string, number>();
  for (const e of ranked) if (e.folderId && !folderRanks.has(e.folderId)) folderRanks.set(e.folderId, e.rank);
  const order: RankedCard[] = ranked.map((e, i) => ({
    task: byId.get(e.taskId)!,
    rank: e.rank,
    position: i + 1,
    source: e.folderId ? "folder" : "card",
    folderId: e.folderId,
    homeFolderId: null,
  }));
  await writeList(tx, order, folderRanks);
}

const hhmmLocal = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
/** "Thu 3 Dec 09:00–11:34" in the device's time zone. */
export function slotLabel(s: { startMs: number; endMs: number }): string {
  const d = new Date(s.startMs);
  const day = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return `${day} ${hhmmLocal(s.startMs)}–${hhmmLocal(s.endMs)}`;
}

/** Shortest scheduled slot. */
export const MIN_SLOT_MS = 60_000;

export interface SlotInput {
  /** Missing: a new slot. */
  id?: string;
  startMs: number;
  endMs: number;
  /** The list, best first. Ignored for a slot that already started (only its end can change). */
  entries: readonly PlanEntry[];
}

/**
 * SCHEDULED priority lists: from a future start to its end, a list is in
 * force. Slots never overlap. A future slot can be changed or deleted; a
 * running one can only end earlier or later; past ones are kept as they were.
 */
export class SlotActions {
  private readonly deps: Deps & { priority: PriorityActions };
  constructor(deps: Deps & { priority: PriorityActions }) {
    this.deps = deps;
  }

  async save(input: SlotInput, now = Date.now()): Promise<PrioritySlot> {
    const startMs = Math.trunc(input.startMs);
    const endMs = Math.trunc(input.endMs);
    const slot = await this.deps.store.write(async (tx) => {
      const slots = await tx.listSlots();
      const old = input.id ? slots.find((s) => s.id === input.id) : undefined;
      if (input.id && !old) throw new ValidationError("That scheduled list was deleted");
      const running = !!old && old.startMs <= now;
      if (old && old.endMs <= now) throw new ValidationError("A past slot cannot be changed");
      const start = running ? old.startMs : startMs;
      if (!Number.isFinite(start) || !Number.isFinite(endMs)) throw new ValidationError("Pick a start and an end");
      if (!running && start <= now) throw new ValidationError("The start must be in the future");
      if (endMs <= now) throw new ValidationError("The end must be in the future");
      if (endMs - start < MIN_SLOT_MS) throw new ValidationError("A slot must last at least a minute");
      const clash = slots.find((s) => s.id !== input.id && s.startMs < endMs && start < s.endMs);
      if (clash) throw new ValidationError(`Overlaps the scheduled list ${slotLabel(clash)}`);
      let next: PrioritySlot;
      if (running) next = { ...old, endMs };
      else {
        if (input.entries.length === 0) throw new ValidationError("Put at least one task in the list");
        next = {
          id: old?.id ?? uuidv7(now),
          startMs: start,
          endMs,
          list: { savedAt: await savedAtFor(tx, now), entries: input.entries.map((e) => ({ ...e })) },
        };
      }
      await record(tx, { op: "saveSlot", slot: next });
      return next;
    });
    this.deps.sync.requestSync();
    await this.deps.priority.applyDueSlots(now);
    return slot;
  }

  /** Delete a slot that has not started yet. */
  async remove(slotId: string, now = Date.now()): Promise<void> {
    const done = await this.deps.store.write(async (tx) => {
      const slot = await tx.getSlot(slotId);
      if (!slot) return false;
      if (slot.startMs <= now) throw new ValidationError("Only a slot that has not started can be deleted");
      await record(tx, { op: "deleteSlot", slotId });
      return true;
    });
    if (done) this.deps.sync.requestSync();
  }

  /** End the running slot now: the list from before it comes back. */
  async endNow(slotId: string, now = Date.now()): Promise<void> {
    const done = await this.deps.store.write(async (tx) => {
      const slot = await tx.getSlot(slotId);
      if (!slot || slot.startMs > now || slot.endMs <= now) return false;
      await record(tx, { op: "saveSlot", slot: { ...slot, endMs: Math.max(now, slot.startMs + 1) } });
      return true;
    });
    if (done) {
      this.deps.sync.requestSync();
      await this.deps.priority.applyDueSlots(now);
    }
  }
}

/** A folder-ranked group dragged among itself: its cards swap their order keys, nothing else changes. */
async function reorderGroup(tx: LocalTx, group: readonly RankedCard[]): Promise<boolean> {
  const placements = new Map((await tx.listPlacements()).map((p) => [p.taskId, p]));
  const keys = group.map((c) => placements.get(c.task.id)!.rank).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let changed = false;
  for (const [i, c] of group.entries()) {
    if (placements.get(c.task.id)!.rank === keys[i]) continue;
    await record(tx, { op: "moveTask", taskId: c.task.id, rank: keys[i]! });
    changed = true;
  }
  return changed;
}

/** A typed rank: a whole number from 1 up to `cards` (at least 1). */
function checkRank(rank: number, cards: number): void {
  const max = Math.min(Math.max(1, cards), MAX_PRIORITY_RANK);
  if (!Number.isInteger(rank) || rank < 1 || rank > max) throw new ValidationError(`Rank must be a whole number from 1 to ${max}`);
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
