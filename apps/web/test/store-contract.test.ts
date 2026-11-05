/**
 * ONE contract, TWO implementations (Liskov substitution, proven by tests):
 * MemoryStore and DexieStore must behave identically.
 */
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { uuidv7, type Change, type LogEntry } from "@pm/shared";
import { DexieStore } from "../src/adapters/dexie-store.ts";
import { MemorySessionStore, MemoryStore } from "../src/adapters/memory-store.ts";
import type { LocalStore, SessionStore } from "../src/core/ports.ts";

const log = (day: string, seconds = 1, title = "t"): LogEntry => ({ id: uuidv7(), day, seconds, taskTitle: title });
const task = (title: string) => ({ id: uuidv7(), title, description: null, dueDate: null });
const change = (): Change => ({ changeId: uuidv7(), op: "deleteLog", logId: uuidv7() });

let n = 0;
const impls: Array<[string, () => LocalStore & Partial<SessionStore>, () => SessionStore]> = [
  ["MemoryStore", () => new MemoryStore(), () => new MemorySessionStore()],
  ["DexieStore", () => new DexieStore(`test-${n++}`), () => new DexieStore(`test-sessions-${n++}`)],
];

describe.each(impls)("%s", (_name, makeStore, makeSessions) => {
  it("starts empty", async () => {
    const s = makeStore();
    expect(await s.listTasks()).toEqual([]);
    expect(await s.cursor()).toBe(0);
    expect(await s.purgedBefore()).toBeNull();
    expect(await s.listOutbox()).toEqual([]);
  });

  it("writes tasks/placements/logs and reads them back", async () => {
    const s = makeStore();
    const t = task("Gym");
    const l1 = log("2026-11-05", 10);
    const l2 = log("2026-11-06", 20);
    await s.write(async (tx) => {
      await tx.putTask(t);
      await tx.putPlacement({ taskId: t.id, rank: "a0" });
      await tx.putLog(l1);
      await tx.putLog(l2);
    });
    expect(await s.listTasks()).toEqual([t]);
    expect(await s.listPlacements()).toEqual([{ taskId: t.id, rank: "a0" }]);
    expect(await s.listLogsForDay("2026-11-05")).toEqual([l1]);
    expect(await s.listLogsBetween("2026-11-01", "2026-11-30")).toEqual([l1, l2]);
    expect(await s.listLogsBetween("2026-11-06", "2026-11-06")).toEqual([l2]);
  });

  it("a failed write changes nothing (atomic)", async () => {
    const s = makeStore();
    await expect(
      s.write(async (tx) => {
        await tx.putTask(task("half"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await s.listTasks()).toEqual([]);
  });

  it("outbox keeps insertion order and removes by changeId", async () => {
    const s = makeStore();
    const [a, b, c] = [change(), change(), change()];
    await s.write(async (tx) => {
      await tx.enqueue(a);
      await tx.enqueue(b);
      await tx.enqueue(c);
    });
    expect(await s.listOutbox()).toEqual([a, b, c]);
    await s.removeFromOutbox([a.changeId, c.changeId]);
    expect(await s.listOutbox()).toEqual([b]);
  });

  it("deleteLogsBefore is strict (<) and clearSynced keeps the outbox", async () => {
    const s = makeStore();
    const keep = log("2026-01-01");
    const c = change();
    await s.write(async (tx) => {
      await tx.putLog(log("2025-12-31"));
      await tx.putLog(keep);
      await tx.enqueue(c);
      await tx.deleteLogsBefore("2026-01-01");
    });
    expect(await s.listLogsBetween("2000-01-01", "2100-01-01")).toEqual([keep]);
    await s.write((tx) => tx.clearSynced());
    expect(await s.listLogsBetween("2000-01-01", "2100-01-01")).toEqual([]);
    expect(await s.listOutbox()).toEqual([c]);
  });

  it("cursor and purgedBefore persist; wipe clears everything", async () => {
    const s = makeStore();
    await s.write(async (tx) => {
      await tx.setCursor(42);
      await tx.setPurgedBefore("2026-01-01");
      await tx.enqueue(change());
      await tx.putTask(task("x"));
    });
    expect(await s.cursor()).toBe(42);
    expect(await s.purgedBefore()).toBe("2026-01-01");
    await s.wipe();
    expect(await s.cursor()).toBe(0);
    expect(await s.purgedBefore()).toBeNull();
    expect(await s.listOutbox()).toEqual([]);
    expect(await s.listTasks()).toEqual([]);
  });

  it("notifies subscribers after commits", async () => {
    const s = makeStore();
    let calls = 0;
    const off = s.subscribe(() => calls++);
    await s.write((tx) => tx.putTask(task("x")));
    await s.removeFromOutbox([]);
    off();
    await s.write((tx) => tx.putTask(task("y")));
    expect(calls).toBeGreaterThanOrEqual(1);
    const before = calls;
    await s.write((tx) => tx.putTask(task("z")));
    expect(calls).toBe(before);
  });

  it("session store: save, owner survives clearToken, clear forgets all", async () => {
    const ss = makeSessions();
    const session = { token: "tok", user: { id: "u1", username: "deepan" } };
    expect(await ss.load()).toBeNull();
    await ss.save(session);
    expect(await ss.load()).toEqual(session);
    expect(await ss.owner()).toBe("u1");
    await ss.clearToken();
    expect(await ss.load()).toBeNull();
    expect(await ss.owner()).toBe("u1");
    await ss.clear();
    expect(await ss.owner()).toBeNull();
  });
});
