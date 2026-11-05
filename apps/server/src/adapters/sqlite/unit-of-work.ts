import type { DatabaseSync } from "node:sqlite";
import type { Repositories } from "../../ports/repositories.ts";
import type { UnitOfWork } from "../../ports/unit-of-work.ts";
import { SqliteChangeLogRepository } from "./change-log-repository.ts";
import { SqliteLogRepository } from "./log-repository.ts";
import { SqliteSessionRepository } from "./session-repository.ts";
import { SqlitePlacementRepository, SqliteTaskRepository } from "./task-repository.ts";
import { SqliteUserRepository } from "./user-repository.ts";

/**
 * One SQLite connection, so units of work are queued one after another:
 * otherwise request B could run statements inside request A's open
 * transaction while A awaits. Writes here take microseconds, so a queue
 * costs nothing noticeable.
 */
export class SqliteUnitOfWork implements UnitOfWork {
  private readonly repos: Repositories;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.repos = {
      users: new SqliteUserRepository(db),
      sessions: new SqliteSessionRepository(db),
      tasks: new SqliteTaskRepository(db),
      placements: new SqlitePlacementRepository(db),
      logs: new SqliteLogRepository(db),
      changeLog: new SqliteChangeLogRepository(db),
    };
  }

  run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    const next = this.queue.then(() => this.transaction(work));
    this.queue = next.catch(() => undefined); // a failed unit must not block the queue
    return next;
  }

  private async transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await work(this.repos);
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
