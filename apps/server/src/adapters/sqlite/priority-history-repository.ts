import type { DatabaseSync } from "node:sqlite";
import type { PrioritySnapshot } from "@pm/shared";
import type { PriorityHistoryRepository } from "../../ports/repositories.ts";
import { selectIn, type Row } from "./sql.ts";

const toSnapshot = (r: Row): PrioritySnapshot => ({
  id: r.id as string,
  at: Number(r.at),
  titles: JSON.parse(r.titles as string) as string[],
});

export class SqlitePriorityHistoryRepository implements PriorityHistoryRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async get(userId: string, id: string) {
    const r = this.db.prepare("SELECT * FROM priority_history WHERE user_id = ? AND id = ?").get(userId, id) as
      | Row
      | undefined;
    return r ? toSnapshot(r) : null;
  }

  async getMany(userId: string, ids: readonly string[]) {
    return selectIn(this.db, (p) => `SELECT * FROM priority_history WHERE user_id = ? AND id IN (${p})`, [userId], ids).map(
      toSnapshot,
    );
  }

  async listAll(userId: string) {
    return (
      this.db.prepare("SELECT * FROM priority_history WHERE user_id = ? ORDER BY at, id").all(userId) as Row[]
    ).map(toSnapshot);
  }

  async insert(userId: string, s: PrioritySnapshot) {
    this.db
      .prepare("INSERT INTO priority_history (user_id, id, at, titles) VALUES (?, ?, ?, ?)")
      .run(userId, s.id, s.at, JSON.stringify(s.titles));
  }
}
