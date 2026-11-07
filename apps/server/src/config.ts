import { resolve } from "node:path";
import { z } from "zod";
import { SYNC_LIMITS } from "@pm/shared";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const EnvSchema = z.object({
  HOST: z.string().default("127.0.0.1"), // localhost only: Tailscale serve forwards to it
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATA_DIR: z.string().default("./data"),
  ALLOW_SIGNUP: bool.default(true),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).default(90),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1).default(60_000),
  SSE_HEARTBEAT_MS: z.coerce.number().int().min(10).default(25_000),
  CLEANUP_INTERVAL_MS: z.coerce.number().int().min(1000).default(6 * 60 * 60 * 1000),
  WEB_DIR: z.string().optional(), // built PWA to serve at "/" (production)
  ACCESS_LOG: bool.default(false),
});

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  allowSignUp: boolean;
  sessionTtlDays: number;
  authRateLimit: { max: number; windowMs: number };
  sseHeartbeatMs: number;
  cleanupIntervalMs: number;
  changeLogRetentionDays: number;
  pullPageSize: number;
  maxBodyBytes: number;
  webDir: string | null;
  accessLog: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = EnvSchema.parse(env);
  return {
    host: e.HOST,
    port: e.PORT,
    dbPath: resolve(e.DATA_DIR, "personal-manager.db"),
    allowSignUp: e.ALLOW_SIGNUP,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    authRateLimit: { max: e.AUTH_RATE_LIMIT_MAX, windowMs: e.AUTH_RATE_LIMIT_WINDOW_MS },
    sseHeartbeatMs: e.SSE_HEARTBEAT_MS,
    cleanupIntervalMs: e.CLEANUP_INTERVAL_MS,
    changeLogRetentionDays: SYNC_LIMITS.changeLogRetentionDays,
    pullPageSize: SYNC_LIMITS.maxPullChanges,
    maxBodyBytes: 4 * 1024 * 1024,
    webDir: e.WEB_DIR ? resolve(e.WEB_DIR) : null,
    accessLog: e.ACCESS_LOG,
  };
}
