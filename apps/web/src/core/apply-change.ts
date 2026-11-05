import type { Change, Task, TaskPatch } from "@pm/shared";
import type { LocalTx } from "./ports.ts";

/**
 * Applies a change to the LOCAL copy. Used in two places:
 *   1. when the user acts (optimistic update, before the server knows),
 *   2. after a pull, to re-apply changes still waiting in the outbox
 *      ("rebase"), so a pull never visually undoes your unsynced edits.
 * Mirrors the server's handlers, minus the change_log bookkeeping.
 */
export async function applyChangeLocally(tx: LocalTx, change: Change): Promise<void> {
  switch (change.op) {
    case "createTask":
      await tx.putTask(change.task);
      await tx.putPlacement({ taskId: change.task.id, rank: change.rank });
      return;
    case "updateTask": {
      const task = await tx.getTask(change.taskId);
      if (task) await tx.putTask(patchTask(task, change.patch));
      return;
    }
    case "moveTask": {
      const p = await tx.getPlacement(change.taskId);
      if (p) await tx.putPlacement({ ...p, rank: change.rank });
      return;
    }
    case "deleteTask":
      await tx.deletePlacement(change.taskId);
      await tx.deleteTask(change.taskId);
      return;
    case "createLog": {
      const purged = await tx.getPurgedBefore();
      if (!purged || change.entry.day >= purged) await tx.putLog(change.entry);
      return;
    }
    case "deleteLog":
      await tx.deleteLog(change.logId);
      return;
    case "purgeLogsBefore": {
      const purged = await tx.getPurgedBefore();
      const guard = purged && purged > change.before ? purged : change.before;
      await tx.deleteLogsBefore(guard);
      await tx.setPurgedBefore(guard);
      return;
    }
  }
}

/** Field-level patch: only fields present in the patch change. */
function patchTask(task: Task, patch: TaskPatch): Task {
  return {
    ...task,
    ...(patch.title !== undefined && { title: patch.title }),
    ...(patch.description !== undefined && { description: patch.description }),
    ...(patch.dueDate !== undefined && { dueDate: patch.dueDate }),
  };
}
