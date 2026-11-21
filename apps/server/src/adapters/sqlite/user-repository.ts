import type { DatabaseSync } from "node:sqlite";
import { UsernameTakenError } from "../../domain/errors.ts";
import type { UserRecord, UserRepository } from "../../ports/repositories.ts";
import { isUniqueViolation, type Row } from "./sql.ts";

const toUser = (r: Row): UserRecord => ({
  id: r.id as string,
  username: r.username as string,
  passwordHash: r.password_hash as string,
  purgedBefore: (r.purged_before as string | null) ?? null,
  timerStart: r.timer_start === null || r.timer_start === undefined ? null : Number(r.timer_start),
});

export class SqliteUserRepository implements UserRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async findByUsername(username: string) {
    const r = this.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as Row | undefined;
    return r ? toUser(r) : null;
  }

  async findById(userId: string) {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as Row | undefined;
    return r ? toUser(r) : null;
  }

  async insert(u: UserRecord) {
    try {
      this.db
        .prepare("INSERT INTO users (id, username, password_hash, purged_before) VALUES (?, ?, ?, ?)")
        .run(u.id, u.username, u.passwordHash, u.purgedBefore);
    } catch (err) {
      if (isUniqueViolation(err)) throw new UsernameTakenError();
      throw err;
    }
  }

  async raiseTimerStart(userId: string, startMs: number) {
    this.db
      .prepare("UPDATE users SET timer_start = MAX(COALESCE(timer_start, 0), ?) WHERE id = ?")
      .run(startMs, userId);
  }

  async setPurgedBefore(userId: string, day: string) {
    this.db.prepare("UPDATE users SET purged_before = ? WHERE id = ?").run(day, userId);
  }
}
