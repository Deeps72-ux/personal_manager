import type { DatabaseSync } from "node:sqlite";
import type { PlanList, PrioritySlot } from "@pm/shared";
import type { SlotRepository } from "../../ports/repositories.ts";
import { selectIn, type Row } from "./sql.ts";

const toSlot = (r: Row): PrioritySlot => ({
  id: r.id as string,
  startMs: Number(r.start_ms),
  endMs: Number(r.end_ms),
  list: JSON.parse(r.list as string) as PlanList,
  ...(r.restore === null || r.restore === undefined ? {} : { restore: JSON.parse(r.restore as string) as PlanList }),
  ...(r.restored === null || r.restored === undefined ? {} : { restored: Number(r.restored) === 1 }),
});

export class SqliteSlotRepository implements SlotRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async get(userId: string, id: string) {
    const r = this.db.prepare("SELECT * FROM priority_slots WHERE user_id = ? AND id = ?").get(userId, id) as Row | undefined;
    return r ? toSlot(r) : null;
  }

  async getMany(userId: string, ids: readonly string[]) {
    return selectIn(this.db, (p) => `SELECT * FROM priority_slots WHERE user_id = ? AND id IN (${p})`, [userId], ids).map(toSlot);
  }

  async listAll(userId: string) {
    return (this.db.prepare("SELECT * FROM priority_slots WHERE user_id = ? ORDER BY start_ms, id").all(userId) as Row[]).map(toSlot);
  }

  async put(userId: string, s: PrioritySlot) {
    this.db
      .prepare(
        `INSERT INTO priority_slots (user_id, id, start_ms, end_ms, list, restore, restored) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, id) DO UPDATE SET start_ms = excluded.start_ms, end_ms = excluded.end_ms,
           list = excluded.list, restore = excluded.restore, restored = excluded.restored`,
      )
      .run(
        userId,
        s.id,
        s.startMs,
        s.endMs,
        JSON.stringify(s.list),
        s.restore ? JSON.stringify(s.restore) : null,
        s.restored === true ? 1 : s.restored === false ? 0 : null,
      );
  }

  async delete(userId: string, id: string) {
    this.db.prepare("DELETE FROM priority_slots WHERE user_id = ? AND id = ?").run(userId, id);
  }
}
