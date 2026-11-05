import type { DatabaseSync } from "node:sqlite";
import type {
  ChangeLogEntry,
  ChangeLogRepository,
  ChangeOpKind,
  SyncedTable,
} from "../../ports/repositories.ts";
import type { Row } from "./sql.ts";

export class SqliteChangeLogRepository implements ChangeLogRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async append(userId: string, table: SyncedTable, rowId: string, op: ChangeOpKind, nowMs: number) {
    const r = this.db
      .prepare("INSERT INTO change_log (user_id, table_name, row_id, op, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(userId, table, rowId, op, nowMs);
    return Number(r.lastInsertRowid);
  }

  async listAfter(userId: string, cursor: number, limit: number): Promise<ChangeLogEntry[]> {
    const rows = this.db
      .prepare(
        "SELECT seq, table_name, row_id, op FROM change_log WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(userId, cursor, limit) as Row[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      table: r.table_name as SyncedTable,
      rowId: r.row_id as string,
      op: r.op as ChangeOpKind,
    }));
  }

  async wasDeleted(userId: string, table: SyncedTable, rowId: string) {
    const r = this.db
      .prepare(
        "SELECT op FROM change_log WHERE user_id = ? AND table_name = ? AND row_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(userId, table, rowId) as Row | undefined;
    return r?.op === "delete";
  }

  async currentSeq() {
    // AUTOINCREMENT remembers the highest seq ever issued, even after deletes.
    const r = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'change_log'").get() as Row | undefined;
    return r ? Number(r.seq) : 0;
  }

  async floor() {
    const r = this.db.prepare("SELECT MIN(seq) AS m FROM change_log").get() as Row;
    return r.m === null ? this.currentSeq() : Number(r.m) - 1;
  }

  async deleteOlderThan(cutoffMs: number) {
    // Delete a PREFIX by seq (not by time) so floor() = MIN(seq) - 1 stays exact
    // even if the system clock ever jumped backwards.
    const r = this.db.prepare("SELECT MAX(seq) AS m FROM change_log WHERE created_at < ?").get(cutoffMs) as Row;
    if (r.m === null) return 0;
    return Number(this.db.prepare("DELETE FROM change_log WHERE seq <= ?").run(Number(r.m)).changes);
  }
}
