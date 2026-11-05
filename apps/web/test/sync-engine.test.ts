/**
 * Integration: the real client core (actions + SyncEngine + HTTP + SSE
 * adapters) against a real server process. Each "device" = its own store.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7, type Change } from "@pm/shared";
import { applyChangeLocally } from "../src/core/apply-change.ts";
import { startServer, type RunningServer } from "@pm/test-server";
import { HttpRemoteApi } from "../src/adapters/http-api.ts";
import { MemorySessionStore, MemoryStore } from "../src/adapters/memory-store.ts";
import { SseChannel } from "../src/adapters/sse-channel.ts";
import { LogActions, PriorityActions, TaskActions } from "../src/core/actions.ts";
import { AuthService, SessionHolder } from "../src/core/auth.ts";
import { SyncEngine } from "../src/core/sync-engine.ts";
import { priorityOrder } from "../src/core/views.ts";

let server: RunningServer;
beforeAll(async () => {
  server = await startServer({ SSE_HEARTBEAT_MS: "500" });
});
afterAll(() => server.stop());

let counter = 0;
const uniq = () => `dev${Date.now().toString(36)}${counter++}`;

function device(name: string, opts: { baseUrl?: string; realtime?: boolean } = {}) {
  const baseUrl = opts.baseUrl ?? server.baseUrl;
  const store = new MemoryStore();
  const sessions = new MemorySessionStore();
  const holder = new SessionHolder();
  const getToken = () => holder.current?.token ?? null;
  const api = new HttpRemoteApi({ baseUrl, getToken, timeoutMs: 3000 });
  let unauthorized = 0;
  const sync = new SyncEngine({
    store,
    api,
    debounceMs: 10,
    onUnauthorized: () => void unauthorized++,
    ...(opts.realtime ? { realtime: new SseChannel({ baseUrl, getToken, minBackoffMs: 100 }) } : {}),
  });
  const auth = new AuthService({ api, sessions, store, holder });
  return {
    name,
    store,
    sync,
    auth,
    holder,
    tasks: new TaskActions({ store, sync }),
    priority: new PriorityActions({ store, sync }),
    logs: new LogActions({ store, sync }),
    unauthorized: () => unauthorized,
    order: async () => priorityOrder(await store.listTasks(), await store.listPlacements()).map((t) => t.title),
    state: async () => ({
      tasks: (await store.listTasks()).sort((a, b) => (a.id < b.id ? -1 : 1)),
      placements: (await store.listPlacements()).sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
      logs: await store.listLogsBetween("0001-01-01", "9999-12-31"),
    }),
  };
}

async function signedIn(username: string, ...names: string[]) {
  const ds = names.map((n) => device(n));
  await ds[0]!.auth.signUp(username, "password123");
  for (const d of ds.slice(1)) await d.auth.signIn(username, "password123");
  for (const d of ds) d.sync.start();
  return ds;
}

const settle = async (...ds: ReturnType<typeof device>[]) => {
  for (let i = 0; i < 2; i++) for (const d of ds) await d.sync.syncNow();
};

const waitFor = async (cond: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met in time");
};

describe("SyncEngine against the real server", () => {
  it("phone creates, laptop sees it; order + logs converge", async () => {
    const [phone, laptop] = await signedIn(uniq(), "phone", "laptop");
    await phone!.tasks.create({ title: "first" });
    await phone!.tasks.create({ title: "second", dueDate: "2026-11-10" });
    await phone!.logs.add("2026-11-05", "8h", "Sleep");
    await settle(phone!, laptop!);
    expect(await laptop!.order()).toEqual(["second", "first"]);
    expect(await laptop!.state()).toEqual(await phone!.state());
    await waitFor(async () => phone!.sync.getStatus().state === "idle");
    expect(phone!.sync.getStatus()).toMatchObject({ state: "idle", pending: 0 });
    phone!.sync.stop();
    laptop!.sync.stop();
  });

  it("works offline: changes queue up, then flush when the server is reachable", async () => {
    const username = uniq();
    const online = device("mac");
    await online.auth.signUp(username, "password123");
    online.sync.start();

    // Same account, but pointed at a dead port = "offline".
    const offline = device("phone", { baseUrl: "http://127.0.0.1:9" });
    const tokenFromOnline = online.holder.current!;
    offline.holder.set(tokenFromOnline);
    offline.sync.start();
    await offline.tasks.create({ title: "made offline" });
    await offline.logs.add("2026-11-05", 60, "made offline");
    await offline.sync.syncNow();
    expect(offline.sync.getStatus()).toMatchObject({ state: "offline", pending: 2 });
    expect(await offline.order()).toEqual(["made offline"]); // UI still shows it

    // "Back online": same local data + outbox, real server address.
    const back = device("phone");
    back.holder.set(tokenFromOnline);
    for (const c of await offline.store.listOutbox()) await back.store.write((tx) => tx.enqueue(c));
    back.sync.start();
    await back.sync.syncNow();
    expect(back.sync.getStatus().pending).toBe(0);
    await online.sync.syncNow();
    expect(await online.order()).toEqual(["made offline"]);
    for (const d of [online, offline, back]) d.sync.stop();
  });

  it("an edit made WHILE a pull is in flight is not lost (rebase)", async () => {
    const username = uniq();
    const a = device("a");
    await a.auth.signUp(username, "password123");
    a.sync.start();
    await a.tasks.create({ title: "Gym" });
    await a.sync.syncNow();
    const gymId = (await a.store.listTasks())[0]!.id;

    // Device b: its pull() lets the user rename "Gym" locally mid-request.
    const b = device("b");
    await b.auth.signIn(username, "password123");
    const real = new HttpRemoteApi({ baseUrl: server.baseUrl, getToken: () => b.holder.current?.token ?? null });
    let editDuringPull: (() => Promise<void>) | null = null;
    const api = {
      signUp: real.signUp.bind(real),
      signIn: real.signIn.bind(real),
      signOut: real.signOut.bind(real),
      push: real.push.bind(real),
      pull: async (cursor: number) => {
        const page = await real.pull(cursor);
        const edit = editDuringPull;
        editDuringPull = null;
        if (edit) await edit(); // user acts after the response left the server
        return page;
      },
    };
    const engine = new SyncEngine({ store: b.store, api, debounceMs: 10_000 });
    engine.start();
    await engine.syncNow(); // first sync: b now has "Gym"

    editDuringPull = async () => {
      await b.store.write(async (tx) => {
        const change: Change = { changeId: uuidv7(), op: "updateTask", taskId: gymId, patch: { title: "Workout" } };
        await tx.enqueue(change);
        await applyChangeLocally(tx, change);
      });
    };
    await a.tasks.create({ title: "Read" });
    await a.sync.syncNow();
    await engine.syncNow(); // pull returns "Gym" unchanged + "Read"; rebase must keep "Workout"

    expect((await b.order()).sort()).toEqual(["Read", "Workout"]);
    await engine.syncNow(); // the rename is pushed on the next cycle
    await a.sync.syncNow();
    expect((await a.order()).sort()).toEqual(["Read", "Workout"]);
    engine.stop();
    a.sync.stop();
  });

  it("SSE pokes another device, which syncs by itself", async () => {
    const username = uniq();
    const mac = device("mac");
    await mac.auth.signUp(username, "password123");
    const phone = device("phone", { realtime: true });
    await phone.auth.signIn(username, "password123");
    mac.sync.start();
    phone.sync.start();
    await waitFor(async () => phone.sync.getStatus().realtime === "open");

    await mac.tasks.create({ title: "live!" });
    await mac.sync.syncNow();
    await waitFor(async () => (await phone.order()).includes("live!"));
    mac.sync.stop();
    phone.sync.stop();
  });

  it("revoked session → status 'unauthorized' and callback fires; data is kept", async () => {
    const username = uniq();
    const [mac, phone] = await signedIn(username, "mac", "phone");
    await phone!.tasks.create({ title: "keep me" });
    phone!.sync.stop();
    // Sign the phone's session out from the server side, using its own token.
    await new HttpRemoteApi({ baseUrl: server.baseUrl, getToken: () => phone!.holder.current!.token }).signOut();
    phone!.sync.start();
    await phone!.sync.syncNow();
    expect(phone!.sync.getStatus().state).toBe("unauthorized");
    expect(phone!.unauthorized()).toBe(1);
    expect(await phone!.store.listOutbox()).toHaveLength(1);

    // Re-sign-in (same user) keeps data and the outbox flushes.
    await phone!.auth.signIn(username, "password123");
    phone!.sync.start();
    await phone!.sync.syncNow();
    await mac!.sync.syncNow();
    expect(await mac!.order()).toEqual(["keep me"]);
    mac!.sync.stop();
    phone!.sync.stop();
  });

  it("signing in as a DIFFERENT user wipes the previous user's local data", async () => {
    const d = device("shared-laptop");
    await d.auth.signUp(uniq(), "password123");
    d.sync.start();
    await d.tasks.create({ title: "alice's" });
    await d.sync.syncNow();
    d.sync.stop();
    await d.auth.expire();
    await d.auth.signUp(uniq(), "password123");
    expect(await d.store.listTasks()).toEqual([]);
  });

  it("purge on one device: offline log on another is refused and removed locally", async () => {
    const [mac, phone] = await signedIn(uniq(), "mac", "phone");
    await mac!.logs.add("2026-01-05", 100, "kept");
    await mac!.sync.syncNow();
    await phone!.sync.syncNow();
    phone!.sync.stop(); // phone goes offline
    await phone!.logs.add("2025-12-20", 3600, "Reading");
    await mac!.logs.purgeBefore("2026-01-01");
    await mac!.sync.syncNow();
    phone!.sync.start();
    await phone!.sync.syncNow();
    expect((await phone!.store.listLogsBetween("0001-01-01", "9999-12-31")).map((l) => l.taskTitle)).toEqual(["kept"]);
    expect(await phone!.store.purgedBefore()).toBe("2026-01-01");
    mac!.sync.stop();
    phone!.sync.stop();
  });

  it("bad credentials surface friendly messages", async () => {
    const d = device("x");
    await expect(d.auth.signIn("nobody-here", "password123")).rejects.toThrow("Wrong username or password");
    await expect(d.auth.signIn("ab", "password123")).rejects.toThrow("at least 3");
    const off = device("y", { baseUrl: "http://127.0.0.1:9" });
    await expect(off.auth.signIn("someone", "password123")).rejects.toThrow("Can't reach the server");
  });
});
