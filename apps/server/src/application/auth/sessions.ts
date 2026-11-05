import type { AuthResponse } from "@pm/shared";
import type { Repositories, UserRecord } from "../../ports/repositories.ts";
import type { Clock, TokenService } from "../../ports/services.ts";

export interface SessionPolicy {
  ttlMs: number;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Shared by SignUp and SignIn: issue a fresh token for a user. */
export async function openSession(
  repos: Repositories,
  user: UserRecord,
  deps: { tokens: TokenService; clock: Clock; policy: SessionPolicy },
): Promise<AuthResponse> {
  const token = deps.tokens.generate();
  await repos.sessions.insert({
    tokenHash: deps.tokens.hash(token),
    userId: user.id,
    expiresAt: deps.clock.nowMs() + deps.policy.ttlMs,
  });
  return { token, user: { id: user.id, username: user.username } };
}
