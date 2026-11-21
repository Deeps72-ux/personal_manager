import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { LogActions, PriorityActions, TaskActions, TimerActions } from "../src/core/actions.ts";
import { ValidationError } from "../src/core/errors.ts";
import { priorityOrder, scoringOrder, splitPriority } from "../src/core/views.ts";

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
    // Each change to the order also appends a PRIORITY HISTORY snapshot.
    expect((await app.store.listOutbox()).map((c) => c.op)).toEqual([
      "createTask",
      "recordPriority",
      "createTask",
      "recordPriority",
    ]);
    expect((await app.store.listHistory()).map((h) => h.titles)).toEqual([["first"], ["second", "first"]]);
    expect(app.syncRequests()).toBe(2);
  });

  it("a title cannot contain ';' (it ends an activity in a log)", async () => {
    const app = setup();
    await expect(app.tasks.create({ title: "Read; write" })).rejects.toThrow("';'");
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

  it("the WAITING QUEUE: a queued card leaves the list, ranks right after the top task, oldest first", async () => {
    const app = setup();
    for (const t of ["D", "C", "B", "A"]) await app.tasks.create({ title: t }); // A, B, C, D
    const id = async (title: string) => (await app.store.listTasks()).find((t) => t.title === title)!.id;
    const t0 = Date.now() + 1000; // after the snapshots taken when the tasks were made
    await app.priority.enqueue(await id("C"), t0);
    await app.priority.enqueue(await id("D"), t0 + 1000);
    await app.priority.enqueue(await id("C"), t0 + 2000); // already waiting: unchanged
    const split = splitPriority(await app.store.listTasks(), await app.store.listPlacements());
    expect(split.list.map((t) => t.title)).toEqual(["A", "B"]);
    expect(split.queue.map((q) => [q.task.title, q.queuedAt])).toEqual([
      ["C", t0],
      ["D", t0 + 1000],
    ]);
    expect(scoringOrder(await app.store.listTasks(), await app.store.listPlacements()).map((t) => t.title)).toEqual([
      "A",
      "C",
      "D",
      "B",
    ]);
    expect((await app.store.listHistory()).at(-1)!.titles).toEqual(["A", "C", "D", "B"]);

    // Popping = deleting the task everywhere.
    await app.tasks.remove(await id("C"), t0 + 3000);
    expect((await app.store.listHistory()).at(-1)!.titles).toEqual(["A", "D", "B"]);
  });

  it("moving counts positions in the VISIBLE list, skipping queued cards", async () => {
    const app = setup();
    for (const t of ["D", "C", "B", "A"]) await app.tasks.create({ title: t }); // A, B, C, D
    const id = async (title: string) => (await app.store.listTasks()).find((t) => t.title === title)!.id;
    await app.priority.enqueue(await id("B"));
    await app.priority.move(await id("D"), 1); // visible: A, C, D → A, D, C
    expect(splitPriority(await app.store.listTasks(), await app.store.listPlacements()).list.map((t) => t.title)).toEqual([
      "A",
      "D",
      "C",
    ]);
  });

  it("reconcileHistory records the current order only when it differs from the latest snapshot", async () => {
    const app = setup();
    await app.priority.reconcileHistory(5);
    expect(await app.store.listHistory()).toEqual([]); // nothing to record
    await app.store.write(async (tx) => {
      await tx.putTask({ id: "0190a000-0000-7000-8000-00000000000a", title: "Synced", description: null, dueDate: null });
      await tx.putPlacement({ taskId: "0190a000-0000-7000-8000-00000000000a", rank: "a0" });
    });
    await app.priority.reconcileHistory(10);
    await app.priority.reconcileHistory(20);
    expect((await app.store.listHistory()).map((h) => [h.at, h.titles])).toEqual([[10, ["Synced"]]]);
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

  it("manual logs go to the earliest free gap that holds them whole, placed on the clock", async () => {
    const app = setup();
    const day = "2026-11-05";
    const midnight = new Date(2026, 10, 5).getTime();
    const r = await app.logs.add(day, "1h", "a");
    expect(r.ok && r.entry).toMatchObject({ startMs: midnight, seconds: 3600, source: "manual", focus: null });
    expect(await app.logs.propose(day, "30m", "b")).toEqual({
      ok: true,
      seconds: 1800,
      startMs: midnight + 3_600_000,
      endMs: midnight + 5_400_000,
    });
  });

  it("no free time, or no gap long enough: refused, nothing written", async () => {
    const app = setup();
    const day = "2026-11-05";
    expect(await app.logs.add(day, "23h", "a")).toMatchObject({ ok: true });
    const over = await app.logs.add(day, "1h1s", "b");
    expect(over).toMatchObject({ ok: false, error: expect.stringContaining("the longest is 1h") });
    expect(await app.logs.add(day, "1h", "b")).toMatchObject({ ok: true }); // fills the day
    expect(await app.logs.add(day, 1, "c")).toMatchObject({ ok: false, error: expect.stringContaining("remove a log") });
    expect(await app.logs.add("2026-11-06", 1, "c")).toMatchObject({ ok: true }); // other days unaffected
  });

  it("a gap left by a deleted log is reused; a gap too small is skipped", async () => {
    const app = setup();
    const day = "2026-11-05";
    const midnight = new Date(2026, 10, 5).getTime();
    const first = await app.logs.add(day, "20m", "a"); // 00:00–00:20
    await app.logs.add(day, "1h", "b"); // 00:20–01:20
    if (first.ok) await app.logs.remove(first.entry.id); // 00:00–00:20 free again
    expect(await app.logs.propose(day, "50m", "c")).toMatchObject({ ok: true, startMs: midnight + 80 * 60_000 });
    expect(await app.logs.propose(day, "15m", "c")).toMatchObject({ ok: true, startMs: midnight });
  });

  it("an accepted slot that got taken meanwhile is refused", async () => {
    const app = setup();
    const day = "2026-11-05";
    const p = await app.logs.propose(day, "1h", "a");
    await app.logs.add(day, "30m", "other"); // another tab / sync took 00:00–00:30
    if (!p.ok) throw new Error(p.error);
    expect(await app.logs.add(day, p.seconds, "a", p.startMs)).toMatchObject({ ok: false, error: expect.stringContaining("no longer free") });
  });

  it("time covered by the running TIMER is never free", async () => {
    const app = setup();
    const day = "2026-11-05";
    await app.timer.restart(new Date(2026, 10, 5, 1).getTime()); // running since 01:00
    expect(await app.logs.add(day, "1h", "a")).toMatchObject({ ok: true }); // 00:00–01:00
    expect(await app.logs.add(day, 1, "b")).toMatchObject({ ok: false });
    expect(await app.logs.add("2026-11-06", 1, "b")).toMatchObject({ ok: false }); // the timer covers later days too
    expect(await app.logs.add("2026-11-04", "2h", "b")).toMatchObject({ ok: true }); // before it: fine
  });

  it("older untimed manual logs take the earliest time from midnight", async () => {
    const app = setup();
    const day = "2026-11-05";
    const midnight = new Date(2026, 10, 5).getTime();
    await app.store.write(async (tx) =>
      tx.putLog({ id: "0190a000-0000-7000-8000-000000000001", day, seconds: 7200, taskTitle: "old", focus: null, deviation: null }),
    );
    expect(await app.logs.propose(day, "1h", "a")).toMatchObject({ ok: true, startMs: midnight + 7_200_000 });
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
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("One activity") });
    const ok = await app.timer.logAndRestart("  Gym;  ", at(6, 1, 15));
    if (!ok.ok) throw new Error(ok.error);
    expect(await titles(app, "2026-11-05")).toEqual([[3600, "Gym"]]);
    expect(await titles(app, "2026-11-06")).toEqual([[4500, "Gym"]]);
    expect(ok.entries.map((e) => [e.startMs, e.source])).toEqual([
      [at(5, 23), "timer"],
      [at(6, 0), "timer"],
    ]);
    expect(await app.store.timerStart()).toBe(at(6, 1, 15));
    expect((await app.store.listOutbox()).map((c) => c.op)).toEqual(["setTimerStart", "createLog", "createLog", "setTimerStart"]);
  });

  it("the same span can never be logged twice (start is read inside the transaction)", async () => {
    const app = setup();
    await app.timer.restart(at(5, 9));
    expect(await app.timer.logAndRestart("x", at(5, 10))).toMatchObject({ ok: true });
    expect(await app.timer.logAndRestart("x", at(5, 10))).toMatchObject({ ok: false }); // 0 s left to log
    expect(await titles(app, "2026-11-05")).toEqual([[3600, "x"]]);
  });

  it("the timer is not refused by other logs on its days: the time is real (the server settles overlaps)", async () => {
    const app = setup();
    await app.logs.add("2026-11-06", "23h", "earlier");
    await app.timer.restart(at(5, 23));
    expect(await app.timer.logAndRestart("y", at(6, 2))).toMatchObject({ ok: true });
    expect(await app.store.timerStart()).toBe(at(6, 2));
  });

  it("restart and ✓ are shared: they travel as setTimerStart, and the latest start wins locally", async () => {
    const app = setup();
    await app.timer.restart(at(5, 10));
    await app.store.write(async (tx) => {
      const { applyChangeLocally } = await import("../src/core/apply-change.ts");
      await applyChangeLocally(tx, { changeId: "0190a000-0000-7000-8000-0000000000ff", op: "setTimerStart", startMs: at(5, 9) });
    });
    expect(await app.store.timerStart()).toBe(at(5, 10));
  });

  it("a start made up on a fresh device is provisional", async () => {
    const app = setup();
    await app.timer.ensureStart(null, 1000);
    expect(await app.store.write((tx) => tx.isTimerProvisional())).toBe(true);
    const b = setup();
    await b.timer.ensureStart(777, 2000);
    expect(await b.store.write((tx) => tx.isTimerProvisional())).toBe(false);
  });

  it("if the restart fails mid-transaction, the logs are rolled back too (atomic)", async () => {
    const app = setup();
    await app.timer.restart(at(5, 9));
    const write = app.store.write.bind(app.store);
    app.store.write = (fn) =>
      write((tx) => fn({ ...tx, setTimerStart: async () => Promise.reject(new Error("app killed")) }));
    await expect(app.timer.logAndRestart("z", at(5, 10))).rejects.toThrow("app killed");
    expect(await titles(app, "2026-11-05")).toEqual([]);
    expect((await app.store.listOutbox()).map((c) => c.op)).toEqual(["setTimerStart"]); // only the earlier restart
    expect(await app.store.timerStart()).toBe(at(5, 9));
  });

  it("new logs carry no stored scores: they are worked out from the history", async () => {
    const app = setup();
    await app.timer.restart(at(5, 9));
    const r = await app.timer.logAndRestart("Gym", at(5, 10));
    expect(r.ok && r.entries[0]).toMatchObject({ focus: null, deviation: null, taskTitle: "Gym" });
  });

  it("refuses blank text and purged days", async () => {
    const app = setup();
    await app.timer.restart(at(5, 9));
    expect(await app.timer.logAndRestart("   ", at(5, 10))).toMatchObject({ ok: false });
    expect(await app.timer.logAndRestart(" ; ;", at(5, 10))).toMatchObject({ ok: false });
    expect(await app.timer.logAndRestart(";", at(5, 10))).toMatchObject({ ok: false });
    await app.logs.purgeBefore("2026-11-06");
    expect(await app.timer.logAndRestart("x", at(5, 10))).toMatchObject({ ok: false });
    expect(await app.store.timerStart()).toBe(at(5, 9));
  });
});
