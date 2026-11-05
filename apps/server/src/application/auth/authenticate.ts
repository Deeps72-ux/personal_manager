import type { User } from "@pm/shared";
import { UnauthorizedError } from "../../domain/errors.ts";
import type { UnitOfWork } from "../../ports/unit-of-work.ts";
import type { Clock, TokenService } from "../../ports/services.ts";
import { DAY_MS, type SessionPolicy } from "./sessions.ts";

/**
 * Token → user. Sessions slide: each use pushes expiry to now + ttl, but at
 * most once per day to avoid a DB write on every request.
 */
export class Authenticate {
  private readonly deps: { uow: UnitOfWork; tokens: TokenService; clock: Clock; policy: SessionPolicy };

  constructor(deps: { uow: UnitOfWork; tokens: TokenService; clock: Clock; policy: SessionPolicy }) {
    this.deps = deps;
  }

  async execute(token: string): Promise<User> {
    if (!token) throw new UnauthorizedError();
    const tokenHash = this.deps.tokens.hash(token);
    const now = this.deps.clock.nowMs();

    return this.deps.uow.run(async (repos) => {
      const session = await repos.sessions.findValid(tokenHash, now);
      if (!session) throw new UnauthorizedError();
      const user = await repos.users.findById(session.userId);
      if (!user) throw new UnauthorizedError();

      const refreshed = now + this.deps.policy.ttlMs;
      if (refreshed - session.expiresAt > DAY_MS) await repos.sessions.setExpiry(tokenHash, refreshed);

      return { id: user.id, username: user.username };
    });
  }
}

export class SignOut {
  private readonly deps: { uow: UnitOfWork; tokens: TokenService };

  constructor(deps: { uow: UnitOfWork; tokens: TokenService }) {
    this.deps = deps;
  }

  async execute(token: string): Promise<void> {
    await this.deps.uow.run((repos) => repos.sessions.delete(this.deps.tokens.hash(token)));
  }
}
