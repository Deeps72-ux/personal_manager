import type { UnitOfWork } from "../../ports/unit-of-work.ts";
import type { Clock } from "../../ports/services.ts";
import { DAY_MS } from "../auth/sessions.ts";

/** Housekeeping: drop change_log rows past retention and expired sessions. */
export class Cleanup {
  private readonly deps: { uow: UnitOfWork; clock: Clock; changeLogRetentionDays: number };

  constructor(deps: { uow: UnitOfWork; clock: Clock; changeLogRetentionDays: number }) {
    this.deps = deps;
  }

  async execute(): Promise<{ changeLogRows: number; sessions: number }> {
    const now = this.deps.clock.nowMs();
    return this.deps.uow.run(async (repos) => ({
      changeLogRows: await repos.changeLog.deleteOlderThan(now - this.deps.changeLogRetentionDays * DAY_MS),
      sessions: await repos.sessions.deleteExpired(now),
    }));
  }
}
