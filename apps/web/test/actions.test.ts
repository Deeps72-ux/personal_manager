import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { LogActions, PriorityActions, TaskActions, TimerActions } from "../src/core/actions.ts";
import { ValidationError } from "../src/core/errors.ts";
import { priorityOrder } from "../src/core/views.ts";

function setup() {
  const store = new MemoryStore();
  let syncRequests = 0;
  const sync = { requestSync: () => void syncRequests++ };
  return {
    store,
    tasks: new TaskActions({ store, sync }),
    priority: new PriorityActions({ store, sync }),
    logs: new LogActions({ store, sync }),
    timer: new TimerActions({ store, sync }),
    syncRequests: () => syncRequests,
    order: async () => priorityOrder(await store.listTasks(), await store.listPlacements()).map((t) => t.title),
  };
}

describe("TaskActions", () => {
  it("creates tasks at the top, queues a change and asks for a sync", async () => {
    const app = setup();
    await app.tasks.create({ title: "first" });
    await app.tasks.create({ title: "second", description: "  notes ", dueDate: "2026-11-10" });
    expect(await app.order()).toEqual(["second", "first"]);
    const second = (await app.store.listTasks()).find((t) => t.title === "second")!;
    expect(second).toMatchObject({ description: "notes", dueDate: "2026-11-10" });
    expect((await app.store.listOutbox()).map((c) => c.op)).toEqual(["createTask", "createTask"]);
    expect(app.syncRequests()).toBe(2);
  });

  it("blank optional fields become null", async () => {
    const app = setup();
    const t = await app.tasks.create({ title: "x", description: "   ", dueDate: "" });
    expect(t).toMatchObject({ description: null, dueDate: null });
  });

  it.each([
    [{ title: "   " }, "Title is required"],
    [{ title: "x".repeat(201) }, "at most 200"],
    [{ title: "ok", dueDate: "2026-02-30" }, "real date"],
  ])("rejects %j", async (input, msg) => {
    const app = setup();
    await expect(app.tasks.create(input)).rejects.toThrow(ValidationError);
    await expect(app.tasks.create(input)).rejects.toThrow(msg);
    expect(await app.store.listOutbox()).toEqual([]);
  });

  it("remove deletes the card but leaves logs alone", async () => {
    const app = setup();
    const t = await app.tasks.create({ title: "Task7" });
    await app.logs.add("2026-11-05", 27, "Task7");
    await app.tasks.remove(t.id);
    expect(await app.store.listTasks()).toEqual([]);
    expect(await app.store.listPlacements()).toEqual([]);
    expect((await app.store.listLogsForDay("2026-11-05")).map((l) => l.taskTitle)).toEqual(["Task7"]);
  });
});

describe("PriorityActions", () => {
  it("moves a card to any index, changing only that card's rank", async () => {
    const app = setup();
    for (const t of ["D", "C", "B", "A"]) await app.tasks.create({ title: t });
    expect(await app.order()).toEqual(["A", "B", "C", "D"]);
    const before = new Map((await app.store.listPlacements()).map((p) => [p.taskId, p.rank]));

    const d = (await app.store.listTasks()).find((t) => t.title === "D")!;
    await app.priority.move(d.id, 1);
    expect(await app.order()).toEqual(["A", "D", "B", "C"]);

    const after = await app.store.listPlacements();
    const changed = after.filter((p) => before.get(p.taskId) !== p.rank).map((p) => p.taskId);
    expect(changed).toEqual([d.id]);

    await app.priority.move(d.id, 99); // clamps to bottom
    expect(await app.order()).toEqual(["A", "B", "C", "D"]);
    await app.priority.move(d.id, 0);
    expect(await app.order()).toEqual(["D", "A", "B", "C"]);
  });

  it("moving an unknown card does nothing", async () => {
    const app = setup();
    await app.priority.move("nope", 0);
    expect(await app.store.listOutbox()).toEqual([]);
  });
});

describe("LogActions", () => {
  it("accepts number or text seconds, same task many times a day", async () => {
    const app = setup();
    expect(await app.logs.add("2026-11-05", "8*60*60", "Sleep")).toMatchObject({ ok: true });
    expect(await app.logs.add("2026-11-05", 27, "Task7")).toMatchObject({ ok: true });
    expect(await app.logs.add("2026-11-05", "33", "Task7")).toMatchObject({ ok: true });
    const day = await app.store.listLogsForDay("2026-11-05");
    expect(day.map((l) => l.seconds).sort((a, b) => a - b)).toEqual([27, 33, 28_800]);
  });

  it("the ONE rule: a day can never go over 24 hours", async () => {
    const app = setup();
    expect(await app.logs.add("2026-11-05", "23h", "a")).toMatchObject({ ok: true });
    const over = await app.logs.add("2026-11-05", "1h1s", "b");
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain("3,600 s");
    expect(await app.logs.add("2026-11-05", "1h", "b")).toMatchObject({ ok: true }); // exactly 24h
    expect(await app.logs.add("2026-11-05", 1, "c")).toMatchObject({ ok: false });
    expect(await app.logs.add("2026-11-06", 1, "c")).toMatchObject({ ok: true }); // other days unaffected
  });

  it("rejects bad input without writing", async () => {
    const app = setup();
    expect(await app.logs.add("2026-11-05", "abc", "x")).toMatchObject({ ok: false });
    expect(await app.logs.add("2026-11-05", 10, "   ")).toMatchObject({ ok: false, error: "Pick a task" });
    expect(await app.logs.add("2026-02-30", 10, "x")).toMatchObject({ ok: false, error: "Invalid day" });
    expect(await app.store.listOutbox()).toEqual([]);
  });

  it("remove and purge", async () => {
    const app = setup();
    const r = await app.logs.add("2026-11-05", 10, "x");
    await app.logs.add("2025-12-31", 10, "old");
    if (r.ok) await app.logs.remove(r.entry.id);
    await app.logs.purgeBefore("2026-01-01");
    expect(await app.store.listLogsBetween("2000-01-01", "2100-01-01")).toEqual([]);
    expect(await app.store.purgedBefore()).toBe("2026-01-01");
    expect(await app.logs.add("2025-06-01", 10, "x")).toMatchObject({ ok: false });
    await expect(app.logs.purgeBefore("nope")).rejects.toThrow(ValidationError);
  });
});

describe("TimerActions", () => {
  // Local times, so the tests pass in any timezone.
  const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
  const titles = async (app: ReturnType<typeof setup>, day: string) =>
    (await app.store.listLogsForDay(day)).map((l) => [l.seconds, l.taskTitle]);

  it("ensureStart keeps an existing start, else adopts the legacy one, else now", async () => {
    const a = setup();
    expect(await a.timer.ensureStart(null, 1000)).toBe(1000);
    expect(await a.timer.ensureStart(5, 2000)).toBe(1000); // already set: unchanged
    const b = setup();
    expect(await b.timer.ensureStart(777, 2000)).toBe(777);
    expect(await b.store.timerStart()).toBe(777);
  });

  it("logAndRestart: one row per day, same text, and the count restarts, together", async () => {
    const app = setup();
    await app.timer.restart(at(5, 23));
    const r = await app.timer.logAndRestart("  Gym;Read;  ", at(6, 1, 15));
    expect(r).toMatchObject({ ok: true });
    expect(await titles(app, "2026-11-05")).toEqual([[3600, "Gym;Read;"]]);
    expect(await titles(app, "2026-11-06")).toEqual([[4500, "Gym;Read;"]]);
    expect(await app.store.timerStart()).toBe(at(6, 1, 15));
    expect((await app.store.listOutbox()).map((c) => c.op)).toEqual(["createLog", "createLog"]);
    expect(app.syncRequests()).toBe(1);
  });

  it("the same span can never be logged twice (start is read inside the transaction)", async () => {
    const app = setup();
    await app.timer.restart(at(5, 9));
    expect(await app.timer.logAndRestart("x", at(5, 10))).toMatchObject({ ok: true });
    expect(await app.timer.logAndRestart("x", at(5, 10))).toMatchObject({ ok: false }); // 0 s left to log
    expect(await titles(app, "2026-11-05")).toEqual([[3600, "x"]]);
  });

  it("a day over 24 hours refuses everything: no logs, count NOT restarted", async () => {
    const app = setup();
    await app.logs.add("2026-11-06", "23h", "earlier");
    await app.timer.restart(at(5, 23));
    const r = await app.timer.logAndRestart("y", at(6, 2));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("2026-11-06") });
    expect(await titles(app, "2026-11-05")).toEqual([]);
    expect(await app.store.timerStart()).toBe(at(5, 23));
  });

  it("if the restart fails mid-transaction, the logs are rolled back too (atomic)", async () => {
    const app = setup();
    await app.timer.restart(at(5, 9));
    const write = app.store.write.bind(app.store);
    app.store.write = (fn) =>
      write((tx) => fn({ ...tx, setTimerStart: async () => Promise.reject(new Error("app killed")) }));
    await expect(app.timer.logAndRestart("z", at(5, 10))).rejects.toThrow("app killed");
    expect(await titles(app, "2026-11-05")).toEqual([]);
    expect(await app.store.listOutbox()).toEqual([]);
    expect(await app.store.timerStart()).toBe(at(5, 9));
  });

  it("refuses blank text and purged days", async () => {
    const app = setup();
    await app.timer.restart(at(5, 9));
    expect(await app.timer.logAndRestart("   ", at(5, 10))).toMatchObject({ ok: false });
    await app.logs.purgeBefore("2026-11-06");
    expect(await app.timer.logAndRestart("x", at(5, 10))).toMatchObject({ ok: false });
    expect(await app.store.timerStart()).toBe(at(5, 9));
  });
});
