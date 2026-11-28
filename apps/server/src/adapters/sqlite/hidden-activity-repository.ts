import type { DatabaseSync } from "node:sqlite";
import type { HiddenActivity } from "@pm/shared";
import type { HiddenActivityRepository } from "../../ports/repositories.ts";
import { selectIn, type Row } from "./sql.ts";

const toHidden = (r: Row): HiddenActivity => ({ id: r.id as string, name: r.name as string, hiddenAt: Number(r.hidden_at) });

export class SqliteHiddenActivityRepository implements HiddenActivityRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async get(userId: string, id: string) {
    const r = this.db.prepare("SELECT * FROM hidden_activities WHERE user_id = ? AND id = ?").get(userId, id) as Row | undefined;
    return r ? toHidden(r) : null;
  }

  async getMany(userId: string, ids: readonly string[]) {
    return selectIn(this.db, (p) => `SELECT * FROM hidden_activities WHERE user_id = ? AND id IN (${p})`, [userId], ids).map(toHidden);
  }

  async listAll(userId: string) {
    return (this.db.prepare("SELECT * FROM hidden_activities WHERE user_id = ? ORDER BY hidden_at, id").all(userId) as Row[]).map(toHidden);
  }

  async put(userId: string, h: HiddenActivity) {
    this.db
      .prepare(
        `INSERT INTO hidden_activities (user_id, id, name, hidden_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, id) DO UPDATE SET name = excluded.name, hidden_at = excluded.hidden_at`,
      )
      .run(userId, h.id, h.name, h.hiddenAt);
  }

  async delete(userId: string, id: string) {
    this.db.prepare("DELETE FROM hidden_activities WHERE user_id = ? AND id = ?").run(userId, id);
  }
}
