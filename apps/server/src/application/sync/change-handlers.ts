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
import type { Change, ChangeOp, IgnoredReason } from "@pm/shared";
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
    await repos.logs.insert(userId, entry);
    await repos.changeLog.append(userId, "log_entries", entry.id, "upsert", nowMs);
    return applied;
  },

  async deleteLog(repos, { userId, nowMs }, { logId }) {
    if (!(await repos.logs.get(userId, logId))) return ignored("notFound");
    await repos.logs.delete(userId, logId);
    await repos.changeLog.append(userId, "log_entries", logId, "delete", nowMs);
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
