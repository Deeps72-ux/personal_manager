import type { DatabaseSync } from "node:sqlite";
import type { SessionRecord, SessionRepository } from "../../ports/repositories.ts";
import type { Row } from "./sql.ts";

export class SqliteSessionRepository implements SessionRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async insert(s: SessionRecord) {
    this.db
      .prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(s.tokenHash, s.userId, s.expiresAt);
  }

  async findValid(tokenHash: string, nowMs: number) {
    const r = this.db
      .prepare("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?")
      .get(tokenHash, nowMs) as Row | undefined;
    return r
      ? { tokenHash: r.token_hash as string, userId: r.user_id as string, expiresAt: Number(r.expires_at) }
      : null;
  }

  async setExpiry(tokenHash: string, expiresAt: number) {
    this.db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(expiresAt, tokenHash);
  }

  async delete(tokenHash: string) {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  async deleteExpired(nowMs: number) {
    return Number(this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowMs).changes);
  }
}
