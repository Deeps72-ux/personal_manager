import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { LogActions, PriorityActions, TaskActions, TimerActions } from "../src/core/actions.ts";
import { ValidationError } from "../src/core/errors.ts";
import { singleSegment, splitAt, type Segment } from "../src/core/split.ts";
import { priorityOrder, splitPriority } from "../src/core/views.ts";

/** Local time on 5 Nov 2026 (or another day), as epoch ms. */
const at = (h: number, m = 0, day = 5) => new Date(2026, 10, day, h, m).getTime();

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
    // Nothing is snapshotted until the order is confirmed.
    expect((await app.store.listOutbox()).map((c) => c.op)).toEqual(["createTask", "createTask"]);
    expect(await app.store.listHistory()).toEqual([]);
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
    await app.logs.add("2026-11-05", 27, "Task7", at(9));
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

  it("the WAITING QUEUE: a queued card leaves the visible list, oldest first, and is never snapshotted", async () => {
    const app = setup();
    for (const t of ["D", "C", "B", "A"]) await app.tasks.create({ title: t }); // A, B, C, D
    const id = async (title: string) => (await app.store.listTasks()).find((t) => t.title === title)!.id;
    const t0 = Date.now() + 1000;
    await app.priority.enqueue(await id("C"), t0);
    await app.priority.enqueue(await id("D"), t0 + 1000);
    await app.priority.enqueue(await id("C"), t0 + 2000); // already waiting: unchanged
    const split = splitPriority(await app.store.listTasks(), await app.store.listPlacements());
    expect(split.list.map((t) => t.title)).toEqual(["A", "B"]);
    expect(split.queue.map((q) => [q.task.title, q.queuedAt])).toEqual([
      ["C", t0],
      ["D", t0 + 1000],
    ]);
    expect(await app.store.listHistory()).toEqual([]); // queuing is not a confirm
    await app.priority.confirm(t0 + 3000);
    expect((await app.store.listHistory()).map((h) => [h.at, h.titles, h.confirmed])).toEqual([[t0 + 3000, ["A", "B"], true]]);
  });

  it("pulling a task out of the queue puts it back on TOP (#1); the last one pulled out ends up first", async () => {
    const app = setup();
    for (const t of ["D", "C", "B", "A"]) await app.tasks.create({ title: t }); // A, B, C, D
    const id = async (title: string) => (await app.store.listTasks()).find((t) => t.title === title)!.id;
    const t0 = Date.now() + 1000;
    await app.priority.enqueue(await id("D"), t0);
    await app.priority.enqueue(await id("C"), t0 + 1);
    await app.priority.dequeue(await id("D"));
    const now = async () => splitPriority(await app.store.listTasks(), await app.store.listPlacements());
    expect((await now()).list.map((t) => t.title)).toEqual(["D", "A", "B"]);
    await app.priority.dequeue(await id("C"));
    expect((await now()).list.map((t) => t.title)).toEqual(["C", "D", "A", "B"]);
    expect((await now()).queue).toEqual([]);
    expect((await app.store.listTasks()).map((t) => t.title).sort()).toEqual(["A", "B", "C", "D"]); // not deleted
    expect((await app.store.listOutbox()).map((c) => c.op)).toContain("dequeueTask");
    expect(await app.store.listHistory()).toEqual([]); // waits for the confirm icon

    await app.priority.enqueue(await id("D"), t0 + 5000);
    expect((await now()).queue.map((q) => q.queuedAt)).toEqual([t0 + 5000]);
    await app.priority.dequeue(await id("A")); // not queued: nothing happens
    expect((await now()).list.map((t) => t.title)).toEqual(["C", "A", "B"]);
  });

  it("pulled out with the list empty, it becomes the top task", async () => {
    const app = setup();
    const a = await app.tasks.create({ title: "Only" });
    await app.priority.enqueue(a.id);
    await app.priority.dequeue(a.id);
    expect(splitPriority(await app.store.listTasks(), await app.store.listPlacements()).list.map((t) => t.title)).toEqual(["Only"]);
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

  it("CONFIRM: reorders only count once confirmed, time-stamped at the press; refused when unchanged or empty", async () => {
    const app = setup();
    expect(await app.priority.confirm(5)).toBe(false); // empty list
    for (const t of ["C", "B", "A"]) await app.tasks.create({ title: t }); // A, B, C
    const id = async (title: string) => (await app.store.listTasks()).find((t) => t.title === title)!.id;
    expect(await app.priority.confirm(100)).toBe(true);
    expect(await app.priority.confirm(150)).toBe(false); // same order
    await app.priority.move(await id("C"), 0);
    await app.priority.move(await id("A"), 0);
    await app.priority.move(await id("C"), 0); // C, A, B: only the final order matters
    expect((await app.store.listHistory()).length).toBe(1);
    expect(await app.priority.confirm(200)).toBe(true);
    await app.tasks.create({ title: "New" }); // on top, but not scored until confirmed
    await app.tasks.remove(await id("B"));
    expect((await app.store.listHistory()).map((h) => [h.at, h.titles])).toEqual([
      [100, ["A", "B", "C"]],
      [200, ["C", "A", "B"]],
    ]);
    expect(app.syncRequests()).toBeGreaterThan(0);
  });

  it("upgrade: legacy history and nothing confirmed → today's visible list is confirmed once; a new user is left alone", async () => {
    const fresh = setup();
    await fresh.tasks.create({ title: "x" });
    await fresh.priority.ensureConfirmedStart(10);
    expect(await fresh.store.listHistory()).toEqual([]); // no legacy history: unscored until the first confirm

    const app = setup();
    await app.store.write(async (tx) => {
      await tx.putTask({ id: "0190a000-0000-7000-8000-00000000000a", title: "Synced", description: null, dueDate: null });
      await tx.putPlacement({ taskId: "0190a000-0000-7000-8000-00000000000a", rank: "a0" });
      await tx.putSnapshot({ id: "0190a000-0000-7000-8000-0000000000b1", at: 5, titles: ["Old", "Synced"] });
    });
    await app.priority.ensureConfirmedStart(10);
    await app.priority.ensureConfirmedStart(20);
    expect((await app.store.listHistory()).map((h) => [h.at, h.titles, h.confirmed ?? null])).toEqual([
      [5, ["Old", "Synced"], null],
      [10, ["Synced"], true],
    ]);
  });

  it("moving an unknown card does nothing", async () => {
    const app = setup();
    await app.priority.move("nope", 0);
    expect(await app.store.listOutbox()).toEqual([]);
  });
});

describe("LogActions", () => {
  it("accepts number or text seconds, exactly where asked", async () => {
    const app = setup();
    const r = await app.logs.add("2026-11-05", "8*60*60", "Sleep", at(0));
    expect(r.ok && r.entry).toMatchObject({ startMs: at(0), seconds: 28_800, source: "manual", focus: null });
    expect(await app.logs.add("2026-11-05", 27, "Task7", at(9))).toMatchObject({ ok: true });
    expect(await app.logs.add("2026-11-05", "33", "Task7", at(10))).toMatchObject({ ok: true });
    const day = await app.store.listLogsForDay("2026-11-05");
    expect(day.map((l) => l.seconds).sort((a, b) => a - b)).toEqual([27, 33, 28_800]);
  });

  it("time already taken (another log, the running TIMER) or outside the day is refused, nothing written", async () => {
    const app = setup();
    const day = "2026-11-05";
    await app.logs.add(day, "1h", "a", at(9));
    const outbox = (await app.store.listOutbox()).length;
    expect(await app.logs.add(day, "1h", "b", at(9, 30))).toMatchObject({ ok: false, error: expect.stringContaining("no longer free") });
    expect(await app.logs.add(day, "2h", "b", at(23))).toMatchObject({ ok: false, error: expect.stringContaining("outside") });
    await app.timer.restart(at(20)); // running since 20:00
    expect(await app.logs.add(day, "1m", "b", at(20, 30))).toMatchObject({ ok: false });
    expect(await app.logs.add("2026-11-06", 60, "b", at(1, 0, 6))).toMatchObject({ ok: false }); // the timer covers later days too
    expect((await app.store.listOutbox()).length).toBe(outbox + 1); // only the restart
    expect(await app.logs.add(day, "1h", "b", at(10))).toMatchObject({ ok: true }); // right after "a": fine
  });

  it("addPieces: every labeled piece of the day's split bar becomes a log; same-activity neighbours merge; unlogged skipped", async () => {
    const app = setup();
    const day = "2026-11-05";
    let segs: Segment[] = singleSegment(at(9), at(13));
    segs = splitAt(segs, 0, at(10))!;
    segs = splitAt(segs, 1, at(11))!;
    segs = splitAt(segs, 2, at(12))!;
    segs = segs.map((s, i) => ({ ...s, text: ["Reading;", "reading", "", "Coding;"][i]! }));
    const r = await app.logs.addPieces(day, segs);
    expect(r.ok).toBe(true);
    const logs = (await app.store.listLogsForDay(day)).sort((a, b) => a.startMs! - b.startMs!);
    expect(logs.map((l) => [l.taskTitle, l.startMs, l.seconds, l.source])).toEqual([
      ["Reading", at(9), 7200, "manual"],
      ["Coding", at(12), 3600, "manual"],
    ]);
    // The same pieces again: that time is taken now, and nothing is half-saved.
    expect(await app.logs.addPieces(day, segs)).toMatchObject({ ok: false });
    expect((await app.store.listLogsForDay(day)).length).toBe(2);
    expect(await app.logs.addPieces(day, singleSegment(at(14), at(15)))).toMatchObject({ ok: false, error: expect.stringContaining("Label") });
    expect(await app.logs.addPieces(day, singleSegment(at(14), at(15), "a; b"))).toMatchObject({ ok: false });
  });

  it("a log touching one of the same activity (under a second apart) merges with it: one log, however it was entered", async () => {
    const app = setup();
    const day = "2026-11-05";
    await app.timer.restart(at(9));
    await app.timer.logAndRestart("Sleep;", at(10) - 300); // a timer log ends on a whole second
    await app.timer.restart(at(0, 0, 6)); // the running timer holds the next day, not this one
    expect(await app.logs.add(day, 3600, "sleep", at(10))).toMatchObject({ ok: true });
    expect(await app.logs.add(day, 1800, "Reading", at(11))).toMatchObject({ ok: true }); // another activity: kept apart
    expect(await app.logs.add(day, 1800, "Sleep", at(11, 30))).toMatchObject({ ok: true }); // touches Reading, not Sleep
    const logs = (await app.store.listLogsForDay(day)).sort((a, b) => a.startMs! - b.startMs!);
    expect(logs.map((l) => [l.taskTitle, l.startMs, l.seconds])).toEqual([
      ["Sleep", at(9), 7200],
      ["Reading", at(11), 1800],
      ["Sleep", at(11, 30), 1800],
    ]);
    // The merge travels as changes: the old logs deleted, one created.
    const ops = (await app.store.listOutbox()).map((c) => c.op);
    expect(ops.filter((o) => o === "deleteLog")).toHaveLength(1);
  });

  it("rejects bad input without writing", async () => {
    const app = setup();
    expect(await app.logs.add("2026-11-05", "abc", "x", at(1))).toMatchObject({ ok: false });
    expect(await app.logs.add("2026-11-05", 10, "   ", at(1))).toMatchObject({ ok: false, error: "Pick a task" });
    expect(await app.logs.add("2026-02-30", 10, "x", at(1))).toMatchObject({ ok: false, error: "Invalid day" });
    expect(await app.store.listOutbox()).toEqual([]);
  });

  it("remove and purge", async () => {
    const app = setup();
    const r = await app.logs.add("2026-11-05", 10, "x", at(1));
    await app.logs.add("2025-12-31", 10, "old", new Date(2025, 11, 31, 1).getTime());
    if (r.ok) await app.logs.remove(r.entry.id);
    await app.logs.purgeBefore("2026-01-01");
    expect(await app.store.listLogsBetween("2000-01-01", "2100-01-01")).toEqual([]);
    expect(await app.store.purgedBefore()).toBe("2026-01-01");
    expect(await app.logs.add("2025-06-01", 10, "x", new Date(2025, 5, 1, 1).getTime())).toMatchObject({ ok: false });
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
    await app.logs.add("2026-11-06", "23h", "earlier", at(6, 0));
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

  it("SPLIT: each labeled piece is logged, same-activity neighbours merge, unlogged pieces are dropped, the last runs on to now", async () => {
    const app = setup();
    await app.timer.restart(at(5, 11));
    let segs: Segment[] = singleSegment(at(5, 11), at(5, 13)); // bar opened at 13:00
    segs = splitAt(segs, 0, at(5, 11, 45))!;
    segs = splitAt(segs, 1, at(5, 12, 40))!;
    segs = splitAt(segs, 2, at(5, 12, 50))!;
    segs = segs.map((s, i) => ({ ...s, text: ["Doomscrolling", "doomscrolling;", "", "Lunch"][i]! }));
    const r = await app.timer.logSegments(segs, at(5, 13, 5)); // ✓ pressed at 13:05
    if (!r.ok) throw new Error(r.error);
    const logs = (await app.store.listLogsForDay("2026-11-05")).sort((a, b) => a.startMs! - b.startMs!);
    expect(logs.map((l) => [l.taskTitle, l.startMs, l.seconds, l.source])).toEqual([
      ["Doomscrolling", at(5, 11), 100 * 60, "timer"],
      ["Lunch", at(5, 12, 50), 15 * 60, "timer"],
    ]);
    expect(await app.store.timerStart()).toBe(at(5, 13, 5));
  });

  it("SPLIT: refused when the timer was restarted meanwhile, when nothing is labeled, or a label has two activities", async () => {
    const app = setup();
    await app.timer.restart(at(5, 9));
    const segs = splitAt(singleSegment(at(5, 9), at(5, 10)), 0, at(5, 9, 30))!;
    expect(await app.timer.logSegments(segs, at(5, 10))).toMatchObject({ ok: false, error: "Type what you did" });
    expect(await app.timer.logSegments([{ ...segs[0]!, text: "a; b" }, segs[1]!], at(5, 10))).toMatchObject({ ok: false });
    await app.timer.restart(at(5, 9, 10)); // another device
    expect(await app.timer.logSegments([{ ...segs[0]!, text: "a" }, segs[1]!], at(5, 10))).toMatchObject({
      ok: false,
      error: expect.stringContaining("restarted"),
    });
    expect(await titles(app, "2026-11-05")).toEqual([]);
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
