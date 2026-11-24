/**
 * The TASKS tab's folder tree, worked out from the synced rows. Pure: no
 * storage, no side effects.
 *
 * Each folder (and the top level) lists, in order:
 *   1. the RECENT area: tasks and folders created or moved in, mixed, by
 *      their manual order (newest on top), until dragged out;
 *   2. the other sub-folders, by their manual order;
 *   3. the other tasks, by their manual order.
 *
 * Rows from devices that were apart can disagree; the tree never breaks:
 *   - a folder whose parent is gone shows at the top level,
 *   - folders that ended up inside each other (a loop) show at the top level,
 *   - a task whose folder is gone shows at the top level.
 */
import { compareRanked, type Folder, type Placement, type Task } from "@pm/shared";

/** null = the top level of the TASKS tab. */
export type FolderId = string | null;

/** Order key of a task that has none yet (older versions): its priority rank. */
const FALLBACK_KEY = "a0";

/** One row of a folder's list. `key` is its order key, `top` = in the recent area. */
export type Entry =
  | { kind: "folder"; id: string; folder: Folder; top: boolean; key: string }
  | { kind: "task"; id: string; task: Task; top: boolean; key: string };

export interface FolderTree {
  has(id: string): boolean;
  get(id: string): Folder | undefined;
  /** Where the folder really shows (null = top level). */
  parentOf(id: string): FolderId;
  /** Where the task really shows (null = top level). */
  folderOf(task: Task): FolderId;
  /** Everything directly in `parent`, in display order (recent area, folders, tasks). */
  items(parent: FolderId): Entry[];
  /** Sub-folders of `parent`, in display order. */
  folders(parent: FolderId): Folder[];
  /** Tasks directly in `parent`, in display order. */
  tasks(parent: FolderId): Task[];
  /** The task's order key in its folder. */
  taskKey(task: Task): string;
  /** Top level → `id` (empty for the top level). */
  path(id: FolderId): Folder[];
  /** Every folder inside `id`, at any depth (not `id` itself). */
  descendants(id: string): Folder[];
  /** Tasks inside `id` at any depth. */
  taskCount(id: string): number;
  /** True if `target` is `id` or inside it: `id` cannot move there. */
  contains(id: string, target: FolderId): boolean;
  /** Every folder, depth-first in display order, with its depth (top level = 0). */
  flatten(): { folder: Folder; depth: number }[];
}

export function buildFolderTree(
  folderRows: readonly Folder[],
  taskRows: readonly Task[],
  placements: readonly Placement[] = [],
): FolderTree {
  const byId = new Map(folderRows.map((f) => [f.id, f]));
  const parent = new Map<string, FolderId>();
  for (const f of folderRows) parent.set(f.id, inLoop(f.id, byId) ? null : f.parentId && byId.has(f.parentId) ? f.parentId : null);

  const priorityRank = new Map(placements.map((p) => [p.taskId, p.rank]));
  const taskKey = (t: Task) => t.folderRank ?? priorityRank.get(t.id) ?? FALLBACK_KEY;
  const folderOf = (t: Task): FolderId => (t.folderId && byId.has(t.folderId) ? t.folderId : null);

  const children = new Map<FolderId, Entry[]>();
  for (const f of folderRows) push(children, parent.get(f.id)!, { kind: "folder", id: f.id, folder: f, top: !!f.top, key: f.rank });
  for (const t of taskRows) push(children, folderOf(t), { kind: "task", id: t.id, task: t, top: !!t.folderTop, key: taskKey(t) });
  const group = (e: Entry) => (e.top ? 0 : e.kind === "folder" ? 1 : 2);
  for (const list of children.values()) {
    list.sort((a, b) => group(a) - group(b) || compareRanked({ id: a.id, rank: a.key }, { id: b.id, rank: b.key }));
  }
  const childFolders = new Map<FolderId, Folder[]>();
  const childTasks = new Map<FolderId, Task[]>();
  for (const [p, list] of children) {
    childFolders.set(p, list.flatMap((e) => (e.kind === "folder" ? [e.folder] : [])));
    childTasks.set(p, list.flatMap((e) => (e.kind === "task" ? [e.task] : [])));
  }

  const descendants = (id: string): Folder[] =>
    (childFolders.get(id) ?? []).flatMap((f) => [f, ...descendants(f.id)]);

  const tree: FolderTree = {
    has: (id) => byId.has(id),
    get: (id) => byId.get(id),
    parentOf: (id) => parent.get(id) ?? null,
    folderOf,
    items: (p) => children.get(p) ?? [],
    folders: (p) => childFolders.get(p) ?? [],
    tasks: (p) => childTasks.get(p) ?? [],
    taskKey,
    path(id) {
      const out: Folder[] = [];
      for (let cur = id; cur !== null && byId.has(cur); cur = parent.get(cur) ?? null) out.unshift(byId.get(cur)!);
      return out;
    },
    descendants,
    taskCount: (id) => [id, ...descendants(id).map((f) => f.id)].reduce((n, f) => n + tree.tasks(f).length, 0),
    contains(id, target) {
      for (let cur = target; cur !== null; cur = parent.get(cur) ?? null) if (cur === id) return true;
      return false;
    },
    flatten() {
      const out: { folder: Folder; depth: number }[] = [];
      const walk = (p: FolderId, depth: number) => {
        for (const f of tree.folders(p)) {
          out.push({ folder: f, depth });
          walk(f.id, depth + 1);
        }
      };
      walk(null, 0);
      return out;
    },
  };
  return tree;
}

/** True if following parents from `id` comes back to `id`. */
function inLoop(id: string, byId: ReadonlyMap<string, Folder>): boolean {
  const seen = new Set<string>();
  for (let cur = byId.get(id)?.parentId ?? null; cur !== null && byId.has(cur); cur = byId.get(cur)!.parentId) {
    if (cur === id) return true;
    if (seen.has(cur)) return false; // a loop above us: those folders go to the top, so we're fine
    seen.add(cur);
  }
  return false;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Folder names compare without case and surrounding spaces. */
export const nameKey = (name: string): string => name.trim().toLowerCase();
