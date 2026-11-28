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
    case "setTaskRank": {
      const p = await tx.getPlacement(change.taskId);
      if (p) await tx.putPlacement({ ...p, userRank: change.userRank });
      return;
    }
    case "setTaskOwnRank": {
      const p = await tx.getPlacement(change.taskId);
      if (p) await tx.putPlacement({ ...p, ownRank: change.ownRank });
      return;
    }
    case "saveSlot":
      await tx.putSlot(change.slot);
      return;
    case "deleteSlot":
      await tx.deleteSlot(change.slotId);
      return;
    case "hideActivity":
      await tx.putHidden(change.hidden);
      return;
    case "unhideActivity":
      await tx.deleteHidden(change.hiddenId);
      return;
    case "clearTaskRanks":
      for (const p of await tx.listPlacements()) {
        if (p.userRank !== null && p.userRank !== undefined) await tx.putPlacement({ ...p, userRank: null });
      }
      return;
    case "setFolderPriority": {
      const f = await tx.getFolder(change.folderId);
      if (f) await tx.putFolder({ ...f, priority: change.priority });
      return;
    }
    case "queueTask": {
      const p = await tx.getPlacement(change.taskId);
      if (p && (p.queuedAt === null || p.queuedAt === undefined)) await tx.putPlacement({ ...p, queuedAt: change.queuedAt });
      return;
    }
    case "dequeueTask": {
      const p = await tx.getPlacement(change.taskId);
      if (p) await tx.putPlacement({ ...p, rank: change.rank, queuedAt: null });
      return;
    }
    case "recordPriority":
      await tx.putSnapshot(change.snapshot);
      return;
    case "setTimerStart": {
      // The latest start wins, in any order (same rule as the server).
      const current = await tx.getTimerStart();
      await tx.setTimerStart(current === null ? change.startMs : Math.max(current, change.startMs));
      return;
    }
    case "createFolder":
      await tx.putFolder(change.folder);
      return;
    case "renameFolder": {
      const f = await tx.getFolder(change.folderId);
      if (f) await tx.putFolder({ ...f, name: change.name });
      return;
    }
    case "moveFolder": {
      const f = await tx.getFolder(change.folderId);
      // Same refusal as the server: never put a folder inside itself.
      if (f && !(change.parentId !== null && (await isSelfOrAncestor(tx, f.id, change.parentId)))) {
        await tx.putFolder({ ...f, parentId: change.parentId, rank: change.rank, top: change.top ?? false });
      }
      return;
    }
    case "deleteFolder":
      await tx.deleteFolder(change.folderId);
      return;
    case "setTaskFolder": {
      const task = await tx.getTask(change.taskId);
      if (task) {
        await tx.putTask({ ...task, folderId: change.folderId, folderRank: change.folderRank, folderTop: change.folderTop ?? false });
      }
      return;
    }
    case "purgeLogsBefore": {
      const purged = await tx.getPurgedBefore();
      const guard = purged && purged > change.before ? purged : change.before;
      await tx.deleteLogsBefore(guard);
      await tx.setPurgedBefore(guard);
      return;
    }
  }
}

async function isSelfOrAncestor(tx: LocalTx, folderId: string, target: string): Promise<boolean> {
  const seen = new Set<string>();
  for (let id: string | null = target; id !== null && !seen.has(id); ) {
    if (id === folderId) return true;
    seen.add(id);
    id = (await tx.getFolder(id))?.parentId ?? null;
  }
  return false;
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
