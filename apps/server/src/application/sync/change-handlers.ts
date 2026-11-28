/**
 * One handler per change op.
 *
 * OPEN/CLOSED: adding a new op means adding a handler to the map, never
 * editing PushChanges. The `ChangeHandlers` mapped type makes the compiler
 * fail if an op defined in @pm/shared has no handler.
 *
 * Every handler is IDEMPOTENT (a device may resend after a dropped reply)
 * and writes a change_log line for each row it touches, so other devices
 * learn about it on their next pull.
 */
import {
  logSpan,
  overlaps,
  subtractIntervals,
  uuidv7,
  type Change,
  type ChangeOp,
  type IgnoredReason,
  type Interval,
  type LogEntry,
} from "@pm/shared";
import type { Repositories } from "../../ports/repositories.ts";

export type ApplyResult = { status: "applied" } | { status: "ignored"; reason: IgnoredReason };

export interface ChangeContext {
  userId: string;
  nowMs: number;
}

export type ChangeHandler<C extends Change> = (repos: Repositories, ctx: ChangeContext, change: C) => Promise<ApplyResult>;

export type ChangeHandlers = { [K in ChangeOp]: ChangeHandler<Extract<Change, { op: K }>> };

const applied: ApplyResult = { status: "applied" };
const ignored = (reason: IgnoredReason): ApplyResult => ({ status: "ignored", reason });

/** Why an existing-row operation found nothing: deleted elsewhere, or never existed. */
async function missingTask(repos: Repositories, userId: string, taskId: string): Promise<ApplyResult> {
  return ignored((await repos.changeLog.wasDeleted(userId, "tasks", taskId)) ? "deleted" : "notFound");
}

async function missingFolder(repos: Repositories, userId: string, folderId: string): Promise<ApplyResult> {
  return ignored((await repos.changeLog.wasDeleted(userId, "folders", folderId)) ? "deleted" : "notFound");
}

/**
 * True if `folderId` is `target` or one of its ancestors: moving it into
 * `target` would put a folder inside itself. Stops on a missing parent or a
 * loop (neither can come from this server, but never spin forever).
 */
async function isSelfOrAncestor(repos: Repositories, userId: string, folderId: string, target: string): Promise<boolean> {
  const seen = new Set<string>();
  for (let id: string | null = target; id !== null && !seen.has(id); ) {
    if (id === folderId) return true;
    seen.add(id);
    id = (await repos.folders.get(userId, id))?.parentId ?? null;
  }
  return false;
}

/** `entry` cut down to what is left of it outside `cut`: one piece per remaining span (under 1 s dropped). */
function pieces(entry: LogEntry, cut: readonly Interval[], nowMs: number): LogEntry[] {
  const left = subtractIntervals(logSpan(entry.startMs!, entry.seconds), cut);
  return left
    .map((i) => ({ start: i.start, seconds: Math.floor((i.end - i.start) / 1000) }))
    .filter((p) => p.seconds >= 1)
    .map((p, k) => ({ ...entry, id: k === 0 ? entry.id : uuidv7(nowMs), startMs: p.start, seconds: p.seconds }));
}

/** Insert what is left of `entry` outside `cut`. The first piece keeps the id, so a resend stays a no-op. */
async function insertTrimmed(repos: Repositories, userId: string, nowMs: number, entry: LogEntry, cut: readonly Interval[]) {
  const rest = pieces(entry, cut, nowMs);
  for (const p of rest) {
    await repos.logs.insert(userId, p);
    await repos.changeLog.append(userId, "log_entries", p.id, "upsert", nowMs);
  }
  // Fully covered: tell the device that made it to drop its copy.
  if (rest.length === 0) await repos.changeLog.append(userId, "log_entries", entry.id, "delete", nowMs);
}

export const changeHandlers: ChangeHandlers = {
  async createTask(repos, { userId, nowMs }, { task, rank }) {
    if (await repos.tasks.get(userId, task.id)) return applied; // resend: already there
    if (await repos.changeLog.wasDeleted(userId, "tasks", task.id)) return ignored("deleted");
    await repos.tasks.insert(userId, task);
    await repos.placements.insert(userId, { taskId: task.id, rank });
    await repos.changeLog.append(userId, "tasks", task.id, "upsert", nowMs);
    await repos.changeLog.append(userId, "placements", task.id, "upsert", nowMs);
    return applied;
  },

  async updateTask(repos, { userId, nowMs }, { taskId, patch }) {
    if (!(await repos.tasks.get(userId, taskId))) return missingTask(repos, userId, taskId);
    await repos.tasks.update(userId, taskId, patch); // only the fields in the patch
    await repos.changeLog.append(userId, "tasks", taskId, "upsert", nowMs);
    return applied;
  },

  async moveTask(repos, { userId, nowMs }, { taskId, rank }) {
    if (!(await repos.placements.get(userId, taskId))) return missingTask(repos, userId, taskId);
    await repos.placements.setRank(userId, taskId, rank);
    await repos.changeLog.append(userId, "placements", taskId, "upsert", nowMs);
    return applied;
  },

  async deleteTask(repos, { userId, nowMs }, { taskId }) {
    if (!(await repos.tasks.get(userId, taskId))) return ignored("notFound");
    await repos.placements.delete(userId, taskId);
    await repos.tasks.delete(userId, taskId); // HARD delete; logs untouched
    await repos.changeLog.append(userId, "placements", taskId, "delete", nowMs);
    await repos.changeLog.append(userId, "tasks", taskId, "delete", nowMs);
    return applied;
  },

  async createLog(repos, { userId, nowMs }, { entry }) {
    // Purge guard: never let an offline device resurrect purged history.
    const user = await repos.users.findById(userId);
    if (user?.purgedBefore && entry.day < user.purgedBefore) return ignored("purged");
    if (await repos.logs.get(userId, entry.id)) return applied; // resend
    if (await repos.changeLog.wasDeleted(userId, "log_entries", entry.id)) return ignored("deleted");
    // No 24h check here on purpose: that rule lives in the UI only.
    if (entry.startMs === null || entry.startMs === undefined || !entry.source) {
      await repos.logs.insert(userId, entry); // older device: not on the clock
      await repos.changeLog.append(userId, "log_entries", entry.id, "upsert", nowMs);
      return applied;
    }

    // Two devices may have logged the same time while apart. THE TIMER WINS
    // over a manual log: the manual one is trimmed to the time left outside
    // the timer log. Timer vs timer and manual vs manual are kept; the device
    // asks the user which one to keep.
    const span = logSpan(entry.startMs, entry.seconds);
    const clashing = (await repos.logs.listTimedForDay(userId, entry.day)).filter((o) =>
      overlaps(span, logSpan(o.startMs!, o.seconds)),
    );
    if (entry.source === "manual") {
      const timers = clashing.filter((o) => o.source === "timer").map((o) => logSpan(o.startMs!, o.seconds));
      await insertTrimmed(repos, userId, nowMs, entry, timers);
      return applied;
    }
    await repos.logs.insert(userId, entry);
    await repos.changeLog.append(userId, "log_entries", entry.id, "upsert", nowMs);
    for (const manual of clashing.filter((o) => o.source === "manual")) {
      await repos.logs.delete(userId, manual.id);
      await insertTrimmed(repos, userId, nowMs, manual, [span]);
    }
    return applied;
  },

  async deleteLog(repos, { userId, nowMs }, { logId }) {
    if (!(await repos.logs.get(userId, logId))) return ignored("notFound");
    await repos.logs.delete(userId, logId);
    await repos.changeLog.append(userId, "log_entries", logId, "delete", nowMs);
    return applied;
  },

  async setTaskRank(repos, { userId, nowMs }, { taskId, userRank }) {
    if (!(await repos.placements.get(userId, taskId))) return missingTask(repos, userId, taskId);
    await repos.placements.setUserRank(userId, taskId, userRank);
    await repos.changeLog.append(userId, "placements", taskId, "upsert", nowMs);
    return applied;
  },

  async setTaskOwnRank(repos, { userId, nowMs }, { taskId, ownRank }) {
    if (!(await repos.placements.get(userId, taskId))) return missingTask(repos, userId, taskId);
    await repos.placements.setOwnRank(userId, taskId, ownRank);
    await repos.changeLog.append(userId, "placements", taskId, "upsert", nowMs);
    return applied;
  },

  async saveSlot(repos, { userId, nowMs }, { slot }) {
    // Whole row, the last write wins. A slot deleted elsewhere stays deleted.
    if (!(await repos.slots.get(userId, slot.id)) && (await repos.changeLog.wasDeleted(userId, "priority_slots", slot.id))) {
      return ignored("deleted");
    }
    await repos.slots.put(userId, slot);
    await repos.changeLog.append(userId, "priority_slots", slot.id, "upsert", nowMs);
    return applied;
  },

  async deleteSlot(repos, { userId, nowMs }, { slotId }) {
    if (!(await repos.slots.get(userId, slotId))) return ignored("notFound");
    await repos.slots.delete(userId, slotId);
    await repos.changeLog.append(userId, "priority_slots", slotId, "delete", nowMs);
    return applied;
  },

  async clearTaskRanks(repos, { userId, nowMs }) {
    for (const taskId of await repos.placements.clearUserRanks(userId)) {
      await repos.changeLog.append(userId, "placements", taskId, "upsert", nowMs);
    }
    return applied;
  },

  async setFolderPriority(repos, { userId, nowMs }, { folderId, priority }) {
    if (!(await repos.folders.get(userId, folderId))) return missingFolder(repos, userId, folderId);
    await repos.folders.setPriority(userId, folderId, priority);
    await repos.changeLog.append(userId, "folders", folderId, "upsert", nowMs);
    return applied;
  },

  async queueTask(repos, { userId, nowMs }, { taskId, queuedAt }) {
    const p = await repos.placements.get(userId, taskId);
    if (!p) return missingTask(repos, userId, taskId);
    if (p.queuedAt !== null && p.queuedAt !== undefined) return applied; // already waiting: keep the first time
    await repos.placements.setQueuedAt(userId, taskId, queuedAt);
    await repos.changeLog.append(userId, "placements", taskId, "upsert", nowMs);
    return applied;
  },

  async dequeueTask(repos, { userId, nowMs }, { taskId, rank }) {
    const p = await repos.placements.get(userId, taskId);
    if (!p) return missingTask(repos, userId, taskId);
    await repos.placements.setRank(userId, taskId, rank);
    await repos.placements.setQueuedAt(userId, taskId, null);
    await repos.changeLog.append(userId, "placements", taskId, "upsert", nowMs);
    return applied;
  },

  async recordPriority(repos, { userId, nowMs }, { snapshot }) {
    if (await repos.priorityHistory.get(userId, snapshot.id)) return applied; // resend
    await repos.priorityHistory.insert(userId, snapshot);
    await repos.changeLog.append(userId, "priority_history", snapshot.id, "upsert", nowMs);
    return applied;
  },

  async setTimerStart(repos, { userId, nowMs }, { startMs }) {
    await repos.users.raiseTimerStart(userId, startMs);
    // Only bumps the cursor so other devices pull; the value rides on every pull.
    await repos.changeLog.append(userId, "timer", userId, "upsert", nowMs);
    return applied;
  },

  async createFolder(repos, { userId, nowMs }, { folder }) {
    if (await repos.folders.get(userId, folder.id)) return applied; // resend
    if (await repos.changeLog.wasDeleted(userId, "folders", folder.id)) return ignored("deleted");
    await repos.folders.insert(userId, folder);
    await repos.changeLog.append(userId, "folders", folder.id, "upsert", nowMs);
    return applied;
  },

  async renameFolder(repos, { userId, nowMs }, { folderId, name }) {
    if (!(await repos.folders.get(userId, folderId))) return missingFolder(repos, userId, folderId);
    await repos.folders.rename(userId, folderId, name);
    await repos.changeLog.append(userId, "folders", folderId, "upsert", nowMs);
    return applied;
  },

  async moveFolder(repos, { userId, nowMs }, { folderId, parentId, rank, top }) {
    if (!(await repos.folders.get(userId, folderId))) return missingFolder(repos, userId, folderId);
    // Two devices apart may each move one folder into the other: the later
    // one is refused, and the folder is sent again so that device undoes it.
    if (parentId !== null && (await isSelfOrAncestor(repos, userId, folderId, parentId))) {
      await repos.changeLog.append(userId, "folders", folderId, "upsert", nowMs);
      return ignored("invalid");
    }
    await repos.folders.move(userId, folderId, parentId, rank, top ?? false);
    await repos.changeLog.append(userId, "folders", folderId, "upsert", nowMs);
    return applied;
  },

  async deleteFolder(repos, { userId, nowMs }, { folderId }) {
    if (!(await repos.folders.get(userId, folderId))) return ignored("notFound");
    // Only this folder: the device sends the deletes of what was inside it.
    // Anything added inside it meanwhile on another device shows at the top level.
    await repos.folders.delete(userId, folderId);
    await repos.changeLog.append(userId, "folders", folderId, "delete", nowMs);
    return applied;
  },

  async setTaskFolder(repos, { userId, nowMs }, { taskId, folderId, folderRank, folderTop }) {
    if (!(await repos.tasks.get(userId, taskId))) return missingTask(repos, userId, taskId);
    await repos.tasks.setFolder(userId, taskId, folderId, folderRank, folderTop ?? false);
    await repos.changeLog.append(userId, "tasks", taskId, "upsert", nowMs);
    return applied;
  },

  async purgeLogsBefore(repos, { userId, nowMs }, { before }) {
    const user = await repos.users.findById(userId);
    // Purge date only moves forward; an older purge arriving late changes nothing extra.
    const guard = user?.purgedBefore && user.purgedBefore > before ? user.purgedBefore : before;
    const deletedIds = await repos.logs.deleteBefore(userId, guard);
    for (const id of deletedIds) await repos.changeLog.append(userId, "log_entries", id, "delete", nowMs);
    if (guard !== user?.purgedBefore) await repos.users.setPurgedBefore(userId, guard);
    return applied;
  },
};
