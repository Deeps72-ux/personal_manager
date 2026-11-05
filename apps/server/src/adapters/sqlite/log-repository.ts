import type { DatabaseSync } from "node:sqlite";
import type { LogEntry } from "@pm/shared";
import type { LogRepository } from "../../ports/repositories.ts";
import { selectIn, type Row } from "./sql.ts";

const toLog = (r: Row): LogEntry => ({
  id: r.id as string,
  day: r.day as string,
  seconds: Number(r.seconds),
  taskTitle: r.task_title as string,
});

export class SqliteLogRepository implements LogRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async get(userId: string, id: string) {
    const r = this.db
      .prepare("SELECT * FROM log_entries WHERE user_id = ? AND id = ?")
      .get(userId, id) as Row | undefined;
    return r ? toLog(r) : null;
  }

  async getMany(userId: string, ids: readonly string[]) {
    return selectIn(this.db, (p) => `SELECT * FROM log_entries WHERE user_id = ? AND id IN (${p})`, [userId], ids).map(
      toLog,
    );
  }

  async listAll(userId: string) {
    return (
      this.db.prepare("SELECT * FROM log_entries WHERE user_id = ? ORDER BY day, id").all(userId) as Row[]
    ).map(toLog);
  }

  async insert(userId: string, e: LogEntry) {
    this.db
      .prepare("INSERT INTO log_entries (user_id, id, day, seconds, task_title) VALUES (?, ?, ?, ?, ?)")
      .run(userId, e.id, e.day, e.seconds, e.taskTitle);
  }

  async delete(userId: string, id: string) {
    this.db.prepare("DELETE FROM log_entries WHERE user_id = ? AND id = ?").run(userId, id);
  }

  async deleteBefore(userId: string, before: string) {
    // "YYYY-MM-DD" strings sort chronologically, so `<` compares dates.
    const rows = this.db
      .prepare("DELETE FROM log_entries WHERE user_id = ? AND day < ? RETURNING id")
      .all(userId, before) as Row[];
    return rows.map((r) => r.id as string);
  }
}
