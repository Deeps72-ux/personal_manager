/**
 * Starts a server as a separate PROCESS and talks to it only over HTTP.
 *
 * Contract for ANY server implementation (any language) to be testable here:
 *   - started by the command in SERVER_CMD (default: the TypeScript server)
 *   - reads env PORT (0 = pick a free port), HOST, DATA_DIR, plus the
 *     optional AUTH_RATE_LIMIT_MAX / SSE_HEARTBEAT_MS knobs
 *   - prints a line "listening on http://<host>:<port>" when ready
 *   - stores everything under DATA_DIR (so a restart keeps data)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");
const DEFAULT_CMD = `${process.execPath} apps/server/src/main.ts`;

export interface RunningServer {
  baseUrl: string;
  dataDir: string;
  stop(): Promise<void>;
  restart(): Promise<RunningServer>;
}

export async function startServer(env: Record<string, string> = {}, dataDir?: string): Promise<RunningServer> {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), "pm-blackbox-"));
  const [cmd, ...args] = (process.env.SERVER_CMD ?? DEFAULT_CMD).split(" ");
  const child = spawn(cmd!, args, {
    cwd: ROOT,
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", DATA_DIR: dir, AUTH_RATE_LIMIT_MAX: "1000", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const baseUrl = await new Promise<string>((ok, fail) => {
    let out = "";
    const timer = setTimeout(() => fail(new Error(`server did not start:\n${out}`)), 10_000);
    const onData = (buf: Buffer) => {
      out += buf.toString();
      const m = /listening on (http:\/\/[^\s]+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        ok(m[1]!);
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("exit", (code) => fail(new Error(`server exited (${code}):\n${out}`)));
  });

  const stop = () => stopChild(child);
  return {
    baseUrl,
    dataDir: dir,
    stop: async () => {
      await stop();
      if (!dataDir) rmSync(dir, { recursive: true, force: true });
    },
    restart: async () => {
      await stop();
      return startServer(env, dir);
    },
  };
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((ok) => {
    child.once("exit", () => ok());
    child.kill("SIGTERM");
  });
}
