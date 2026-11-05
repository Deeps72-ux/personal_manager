import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Placement, Task, TaskPatch } from "@pm/shared";
import type { PlacementRepository, TaskRepository } from "../../ports/repositories.ts";
import { selectIn, type Row } from "./sql.ts";

const toTask = (r: Row): Task => ({
  id: r.id as string,
  title: r.title as string,
  description: (r.description as string | null) ?? null,
  dueDate: (r.due_date as string | null) ?? null,
});

/** Patch field → column. A whitelist: nothing else can ever reach the SQL. */
const PATCH_COLUMNS = { title: "title", description: "description", dueDate: "due_date" } as const;

export class SqliteTaskRepository implements TaskRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async get(userId: string, id: string) {
    const r = this.db.prepare("SELECT * FROM tasks WHERE user_id = ? AND id = ?").get(userId, id) as Row | undefined;
    return r ? toTask(r) : null;
  }

  async getMany(userId: string, ids: readonly string[]) {
    return selectIn(this.db, (p) => `SELECT * FROM tasks WHERE user_id = ? AND id IN (${p})`, [userId], ids).map(toTask);
  }

  async listAll(userId: string) {
    return (this.db.prepare("SELECT * FROM tasks WHERE user_id = ? ORDER BY id").all(userId) as Row[]).map(toTask);
  }

  async insert(userId: string, t: Task) {
    this.db
      .prepare("INSERT INTO tasks (user_id, id, title, description, due_date) VALUES (?, ?, ?, ?, ?)")
      .run(userId, t.id, t.title, t.description, t.dueDate);
  }

  async update(userId: string, id: string, patch: TaskPatch) {
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    for (const key of Object.keys(PATCH_COLUMNS) as (keyof typeof PATCH_COLUMNS)[]) {
      if (key in patch) {
        sets.push(`${PATCH_COLUMNS[key]} = ?`);
        values.push(patch[key] ?? null);
      }
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE user_id = ? AND id = ?`).run(...values, userId, id);
  }

  async delete(userId: string, id: string) {
    this.db.prepare("DELETE FROM tasks WHERE user_id = ? AND id = ?").run(userId, id);
  }
}

const toPlacement = (r: Row): Placement => ({ taskId: r.task_id as string, rank: r.rank as string });

export class SqlitePlacementRepository implements PlacementRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async get(userId: string, taskId: string) {
    const r = this.db
      .prepare("SELECT * FROM placements WHERE user_id = ? AND task_id = ?")
      .get(userId, taskId) as Row | undefined;
    return r ? toPlacement(r) : null;
  }

  async getMany(userId: string, taskIds: readonly string[]) {
    return selectIn(
      this.db,
      (p) => `SELECT * FROM placements WHERE user_id = ? AND task_id IN (${p})`,
      [userId],
      taskIds,
    ).map(toPlacement);
  }

  async listAll(userId: string) {
    return (this.db.prepare("SELECT * FROM placements WHERE user_id = ? ORDER BY task_id").all(userId) as Row[]).map(
      toPlacement,
    );
  }

  async insert(userId: string, p: Placement) {
    this.db.prepare("INSERT INTO placements (user_id, task_id, rank) VALUES (?, ?, ?)").run(userId, p.taskId, p.rank);
  }

  async setRank(userId: string, taskId: string, rank: string) {
    this.db.prepare("UPDATE placements SET rank = ? WHERE user_id = ? AND task_id = ?").run(rank, userId, taskId);
  }

  async delete(userId: string, taskId: string) {
    this.db.prepare("DELETE FROM placements WHERE user_id = ? AND task_id = ?").run(userId, taskId);
  }
}
