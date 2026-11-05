/**
 * Composition root: the ONLY file that knows concrete adapters.
 *
 * Swapping SQLite for Postgres, Argon2 for something else, or in-memory SSE
 * for Redis means changing lines here; use cases never change (DIP).
 */
import { Authenticate, SignOut } from "./application/auth/authenticate.ts";
import { DAY_MS } from "./application/auth/sessions.ts";
import { SignIn } from "./application/auth/sign-in.ts";
import { SignUp } from "./application/auth/sign-up.ts";
import { changeHandlers } from "./application/sync/change-handlers.ts";
import { Cleanup } from "./application/sync/cleanup.ts";
import { PullChanges } from "./application/sync/pull-changes.ts";
import { PushChanges } from "./application/sync/push-changes.ts";
import { Argon2PasswordHasher } from "./adapters/crypto/argon2-password-hasher.ts";
import { RandomTokenService, SystemClock, UuidV7Generator } from "./adapters/crypto/system.ts";
import { createHttpApp } from "./adapters/http/app.ts";
import { RateLimiter } from "./adapters/http/rate-limiter.ts";
import { ChangeHub } from "./adapters/realtime/change-hub.ts";
import { openDatabase } from "./adapters/sqlite/database.ts";
import { SqliteUnitOfWork } from "./adapters/sqlite/unit-of-work.ts";
import type { Config } from "./config.ts";
import type { Clock, PasswordHasher } from "./ports/services.ts";

export interface Overrides {
  clock?: Clock;
  hasher?: PasswordHasher;
}

export function buildContainer(config: Config, overrides: Overrides = {}) {
  const db = openDatabase(config.dbPath);
  const uow = new SqliteUnitOfWork(db);
  const clock = overrides.clock ?? new SystemClock();
  const hasher = overrides.hasher ?? new Argon2PasswordHasher();
  const tokens = new RandomTokenService();
  const ids = new UuidV7Generator();
  const hub = new ChangeHub();
  const policy = { ttlMs: config.sessionTtlDays * DAY_MS };

  const useCases = {
    signUp: new SignUp({ uow, hasher, ids, tokens, clock, policy, allowSignUp: config.allowSignUp }),
    signIn: new SignIn({ uow, hasher, tokens, clock, policy }),
    signOut: new SignOut({ uow, tokens }),
    authenticate: new Authenticate({ uow, tokens, clock, policy }),
    push: new PushChanges({ uow, clock, notifier: hub, handlers: changeHandlers }),
    pull: new PullChanges({ uow, pageSize: config.pullPageSize }),
    cleanup: new Cleanup({ uow, clock, changeLogRetentionDays: config.changeLogRetentionDays }),
  };

  const app = createHttpApp({
    ...useCases,
    currentCursor: () => uow.run((r) => r.changeLog.currentSeq()),
    hub,
    authLimiter: new RateLimiter({ ...config.authRateLimit, clock }),
    sseHeartbeatMs: config.sseHeartbeatMs,
    maxBodyBytes: config.maxBodyBytes,
  });

  return { app, db, hub, uow, useCases, close: () => db.close() };
}

export type Container = ReturnType<typeof buildContainer>;
