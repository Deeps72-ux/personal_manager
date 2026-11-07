/**
 * Sync must recover ON ITS OWN from flaky networks (phone Wi-Fi power-save,
 * VPN path changes): no user action, no 60-second wait.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "@pm/test-server";
import type { Change, PullResponse, PushResponse } from "@pm/shared";
import { HttpRemoteApi } from "../src/adapters/http-api.ts";
import { MemorySessionStore, MemoryStore } from "../src/adapters/memory-store.ts";
import { SseChannel } from "../src/adapters/sse-channel.ts";
import { TaskActions } from "../src/core/actions.ts";
import { AuthService, SessionHolder } from "../src/core/auth.ts";
import { NetworkError } from "../src/core/errors.ts";
import type { RealtimeStatus, RemoteApi } from "../src/core/ports.ts";
import { SyncEngine } from "../src/core/sync-engine.ts";

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
};

const empty: PullResponse = {
  mode: "incremental",
  cursor: 1,
  hasMore: false,
  purgedBefore: null,
  upserts: { tasks: [], placements: [], logEntries: [] },
  deletes: { tasks: [], placements: [], logEntries: [] },
};

describe("SyncEngine retries by itself", () => {
  it("a change made during a network blip reaches the server without any new trigger", async () => {
    let failures = 2;
    const received: Change[] = [];
    const api: RemoteApi = {
      signUp: async () => ({ token: "t", user: { id: "u", username: "x" } }),
      signIn: async () => ({ token: "t", user: { id: "u", username: "x" } }),
      signOut: async () => undefined,
      push: async (changes): Promise<PushResponse> => {
        if (failures-- > 0) throw new NetworkError("stalled");
        received.push(...changes);
        return { results: changes.map((c) => ({ changeId: c.changeId, status: "applied" as const })) };
      },
      pull: async () => empty,
    };
    const store = new MemoryStore();
    const sync = new SyncEngine({ store, api, debounceMs: 1, retryMinMs: 20, retryMaxMs: 40 });
    sync.start();
    await new TaskActions({ store, sync }).create({ title: "made during a blip" });

    await waitFor(() => received.length === 1);
    expect(received[0]).toMatchObject({ op: "createTask" });
    await waitFor(() => sync.getStatus().state === "idle");
    expect(sync.getStatus().pending).toBe(0);
    sync.stop();
  });

  it("backs off and stops retrying once stopped", async () => {
    let calls = 0;
    const api: RemoteApi = {
      signUp: async () => ({ token: "t", user: { id: "u", username: "x" } }),
      signIn: async () => ({ token: "t", user: { id: "u", username: "x" } }),
      signOut: async () => undefined,
      push: async () => ({ results: [] }),
      pull: async () => {
        calls++;
        throw new NetworkError("down");
      },
    };
    const sync = new SyncEngine({ store: new MemoryStore(), api, retryMinMs: 10, retryMaxMs: 20 });
    sync.start();
    await waitFor(() => calls >= 4);
    sync.stop();
    const at = calls;
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toBeLessThanOrEqual(at + 1);
  });
});

describe("SSE watchdog", () => {
  let server: RunningServer;
  beforeAll(async () => {
    // Heartbeat far longer than the watchdog → the stream looks "silently dead".
    server = await startServer({ SSE_HEARTBEAT_MS: "60000" });
  });
  afterAll(() => server.stop());

  it("drops a silent connection and reconnects (and the engine catches up)", async () => {
    const store = new MemoryStore();
    const holder = new SessionHolder();
    const getToken = () => holder.current?.token ?? null;
    const api = new HttpRemoteApi({ baseUrl: server.baseUrl, getToken });
    await new AuthService({ api, sessions: new MemorySessionStore(), store, holder }).signUp(
      `wd${Date.now().toString(36)}`,
      "password123",
    );
    const statuses: RealtimeStatus[] = [];
    const channel = new SseChannel({ baseUrl: server.baseUrl, getToken, staleAfterMs: 300, minBackoffMs: 50 });
    const disconnect = channel.connect({ onChanged: () => undefined, onStatus: (s) => statuses.push(s) });

    await waitFor(() => statuses.filter((s) => s === "open").length >= 2, 5000);
    expect(statuses).toContain("closed"); // it noticed the silence and re-opened
    disconnect();
  });
});
