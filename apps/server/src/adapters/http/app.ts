/**
 * HTTP adapter (driving side of the hexagon). Its only jobs:
 *   1. turn HTTP requests into validated use-case calls,
 *   2. turn results / domain errors into HTTP responses.
 * No business rules live here.
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { getConnInfo } from "@hono/node-server/conninfo";
import { z } from "zod";
import {
  CredentialsSchema,
  PushRequestSchema,
  type ErrorCode,
  type ErrorResponse,
  type SyncEvent,
  type User,
} from "@pm/shared";
import { DomainError, InvalidRequestError } from "../../domain/errors.ts";
import type { Authenticate, SignOut } from "../../application/auth/authenticate.ts";
import type { SignIn } from "../../application/auth/sign-in.ts";
import type { SignUp } from "../../application/auth/sign-up.ts";
import type { PullChanges } from "../../application/sync/pull-changes.ts";
import type { PushChanges } from "../../application/sync/push-changes.ts";
import type { ChangeHub } from "../realtime/change-hub.ts";
import type { RateLimiter } from "./rate-limiter.ts";
import { staticFiles } from "./static-files.ts";

export interface HttpDeps {
  signUp: SignUp;
  signIn: SignIn;
  signOut: SignOut;
  authenticate: Authenticate;
  push: PushChanges;
  pull: PullChanges;
  currentCursor: () => Promise<number>;
  hub: ChangeHub;
  authLimiter: RateLimiter;
  sseHeartbeatMs: number;
  maxBodyBytes: number;
  /** Directory of the built PWA to serve at "/" (omit in development). */
  webDir?: string | null;
  /** Log one line per API request with its duration. */
  accessLog?: boolean;
}

type Env = { Variables: { user: User; token: string } };

const STATUS: Record<ErrorCode, 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500> = {
  invalid_request: 400,
  unauthorized: 401,
  invalid_credentials: 401,
  signup_disabled: 403,
  not_found: 404,
  username_taken: 409,
  payload_too_large: 413,
  rate_limited: 429,
  internal: 500,
};

function fail(c: Context, code: ErrorCode, message: string) {
  return c.json<ErrorResponse>({ error: code, message }, STATUS[code]);
}

/** Parse the JSON body with a schema; malformed JSON is a 400 like any bad input. */
async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new InvalidRequestError("body must be valid JSON");
  }
  return schema.parse(raw);
}

const CursorQuery = z.coerce.number().int().min(0);

export function createHttpApp(deps: HttpDeps) {
  const app = new Hono<Env>();

  app.use("*", secureHeaders());

  // Access log: one line per API call with its duration (no bodies, no tokens).
  if (deps.accessLog) {
    app.use("/api/*", async (c, next) => {
      if (c.req.path === "/api/health") return next();
      const t0 = performance.now();
      await next();
      const ms = (performance.now() - t0).toFixed(1);
      const ip = getConnInfo(c).remote.address ?? "-";
      const via = c.req.header("tailscale-user-login") ? " ts" : "";
      console.log(`${new Date().toISOString()} ${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms ${ip}${via}`);
    });
  }
  app.use(
    "/api/*",
    bodyLimit({ maxSize: deps.maxBodyBytes, onError: (c) => fail(c, "payload_too_large", "request body too large") }),
  );

  app.onError((err, c) => {
    if (err instanceof DomainError) return fail(c, err.code, err.message);
    if (err instanceof z.ZodError) return fail(c, "invalid_request", z.prettifyError(err));
    console.error(err);
    return fail(c, "internal", "unexpected server error");
  });

  // ── public ──────────────────────────────────────────────
  app.get("/api/health", (c) => c.json({ ok: true }));

  const limitAuth = (c: Context<Env>, username: string) => {
    const ip = getConnInfo(c).remote.address ?? "unknown";
    return deps.authLimiter.hit(`${ip}|${username}`);
  };

  app.post("/api/auth/signup", async (c) => {
    const creds = await body(c, CredentialsSchema);
    if (!limitAuth(c, "*signup*")) return fail(c, "rate_limited", "too many attempts, wait a minute");
    return c.json(await deps.signUp.execute(creds), 201);
  });

  app.post("/api/auth/signin", async (c) => {
    const creds = await body(c, CredentialsSchema);
    if (!limitAuth(c, creds.username)) return fail(c, "rate_limited", "too many attempts, wait a minute");
    return c.json(await deps.signIn.execute(creds));
  });

  // ── everything below requires `Authorization: Bearer <token>` ──
  app.use("/api/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    c.set("user", await deps.authenticate.execute(token));
    c.set("token", token);
    await next();
  });

  app.post("/api/auth/signout", async (c) => {
    await deps.signOut.execute(c.get("token"));
    return c.body(null, 204);
  });

  app.get("/api/me", (c) => c.json(c.get("user")));

  app.post("/api/sync/push", async (c) => {
    const { changes } = await body(c, PushRequestSchema);
    return c.json(await deps.push.execute(c.get("user").id, changes));
  });

  app.get("/api/sync/pull", async (c) => {
    const cursor = CursorQuery.parse(c.req.query("cursor") ?? "0");
    return c.json(await deps.pull.execute(c.get("user").id, cursor));
  });

  /**
   * Server-Sent Events: a long-lived response the server writes to.
   * Sends the current cursor immediately (so a device can catch up on
   * connect), then one "changed" event per push, plus heartbeats so
   * proxies and phones do not drop an idle connection.
   */
  app.get("/api/sync/events", async (c) => {
    const userId = c.get("user").id;
    const initial = await deps.currentCursor();
    return streamSSE(c, async (stream) => {
      const send = (cursor: number) =>
        stream.writeSSE({ event: "changed", data: JSON.stringify({ type: "changed", cursor } satisfies SyncEvent) });
      const unsubscribe = deps.hub.subscribe(userId, (cursor) => void send(cursor));
      stream.onAbort(unsubscribe);
      await send(initial);
      while (!stream.aborted) {
        await stream.sleep(deps.sseHeartbeatMs);
        if (!stream.aborted) await stream.write(": ping\n\n");
      }
    });
  });

  app.all("/api/*", (c) => fail(c, "not_found", "no such endpoint"));

  // The PWA itself (production): everything that is not /api.
  if (deps.webDir) app.get("*", staticFiles(deps.webDir));

  return app;
}
