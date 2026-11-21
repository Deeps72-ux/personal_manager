import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { uuidv7, type LogEntry } from "@pm/shared";
import { migrate } from "../src/adapters/sqlite/database.ts";
import { ch, log, newUser, task, testContainer } from "./helpers.ts";

const MIGRATIONS = join(import.meta.dirname, "../src/adapters/sqlite/migrations");
const DAY = "2026-11-20";
const at = (h: number, m = 0) => new Date(2026, 10, 20, h, m).getTime();
const timed = (title: string, source: "timer" | "manual", from: number, minutes: number): LogEntry => ({
  ...log(DAY, minutes * 60, title),
  startMs: from,
  source,
});

describe("migration 003", () => {
  it("keeps every change_log row and the cursor high-water mark", () => {
    const db = new DatabaseSync(":memory:");
    for (const f of ["001_init.sql", "002_log_metrics.sql"]) db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
    db.exec("PRAGMA user_version = 2");
    const add = db.prepare("INSERT INTO change_log (user_id, table_name, row_id, op, created_at) VALUES ('u', 'tasks', ?, 'upsert', 1)");
    for (let i = 0; i < 5; i++) add.run(`r${i}`);
    db.exec("DELETE FROM change_log WHERE seq >= 4"); // cleaned-up tail: the sequence must still say 5

    migrate(db);

    const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'change_log'").get() as { seq: number };
    expect(seq.seq).toBe(5);
    expect((db.prepare("SELECT COUNT(*) AS n FROM change_log").get() as { n: number }).n).toBe(3);
    const next = db
      .prepare("INSERT INTO change_log (user_id, table_name, row_id, op, created_at) VALUES ('u', 'timer', 'u', 'upsert', 2)")
      .run();
    expect(Number(next.lastInsertRowid)).toBe(6);
  });
});

describe("shared TIMER", () => {
  it("the latest start wins whatever order the devices push in, and every pull carries it", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    expect((await c.useCases.pull.execute(userId, 0)).timerStart).toBeNull();
    const { cursor } = await c.useCases.pull.execute(userId, 0);
    await c.useCases.push.execute(userId, [ch({ op: "setTimerStart", startMs: 2000 })]);
    await c.useCases.push.execute(userId, [ch({ op: "setTimerStart", startMs: 1000 })]); // late, older
    const inc = await c.useCases.pull.execute(userId, cursor);
    expect(inc.cursor).toBeGreaterThan(cursor); // other devices are poked
    expect(inc.timerStart).toBe(2000);
  });
});

describe("waiting QUEUE and PRIORITY HISTORY", () => {
  it("queueTask marks the placement once; a later resend keeps the first time", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const t = task("Passport");
    await c.useCases.push.execute(userId, [
      ch({ op: "createTask", task: t, rank: "a0" }),
      ch({ op: "queueTask", taskId: t.id, queuedAt: 100 }),
      ch({ op: "queueTask", taskId: t.id, queuedAt: 999 }),
    ]);
    const r = await c.useCases.push.execute(userId, [ch({ op: "queueTask", taskId: uuidv7(), queuedAt: 1 })]);
    expect(r.results[0]).toMatchObject({ status: "ignored", reason: "notFound" });
    expect((await c.useCases.pull.execute(userId, 0)).upserts.placements).toEqual([{ taskId: t.id, rank: "a0", queuedAt: 100 }]);
  });

  it("snapshots are stored once and come back in time order", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const s1 = { id: uuidv7(), at: 2000, titles: ["B", "A"] };
    const s0 = { id: uuidv7(), at: 1000, titles: ["A"] };
    await c.useCases.push.execute(userId, [ch({ op: "recordPriority", snapshot: s1 })]);
    const { cursor } = await c.useCases.pull.execute(userId, 0);
    await c.useCases.push.execute(userId, [
      ch({ op: "recordPriority", snapshot: s0 }),
      ch({ op: "recordPriority", snapshot: s0 }),
    ]);
    expect((await c.useCases.pull.execute(userId, 0)).upserts.priorityHistory).toEqual([s0, s1]);
    expect((await c.useCases.pull.execute(userId, cursor)).upserts.priorityHistory).toEqual([s0]);
  });
});

describe("overlapping logs from two devices", () => {
  const setup = async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const push = (...entries: LogEntry[]) =>
      c.useCases.push.execute(userId, entries.map((entry) => ch({ op: "createLog", entry })));
    const logs = async () =>
      (await c.useCases.pull.execute(userId, 0)).upserts.logEntries
        .map((l) => ({ title: l.taskTitle, source: l.source, startMs: l.startMs, minutes: l.seconds / 60 }))
        .sort((a, b) => a.startMs! - b.startMs!);
    return { c, userId, push, logs };
  };

  it("a TIMER log arriving later trims the manual log it covers (split in two if needed)", async () => {
    const { push, logs } = await setup();
    const manual = timed("Read", "manual", at(10), 120); // 10:00–12:00
    await push(manual);
    await push(timed("Gym", "timer", at(10, 30), 30)); // 10:30–11:00
    expect(await logs()).toEqual([
      { title: "Read", source: "manual", startMs: at(10), minutes: 30 },
      { title: "Gym", source: "timer", startMs: at(10, 30), minutes: 30 },
      { title: "Read", source: "manual", startMs: at(11), minutes: 60 },
    ]);
    // A resend of the original manual log changes nothing (its id is the first piece).
    await push(manual);
    expect(await logs()).toHaveLength(3);
  });

  it("a MANUAL log arriving later keeps only the time outside timer logs, or vanishes", async () => {
    const { c, userId, push, logs } = await setup();
    await push(timed("Gym", "timer", at(9), 60)); // 09:00–10:00
    await push(timed("Read", "manual", at(9, 30), 60)); // 09:30–10:30 → 10:00–10:30
    const covered = timed("Nap", "manual", at(9, 15), 15); // inside the timer log
    const { cursor } = await c.useCases.pull.execute(userId, 0);
    await push(covered);
    expect(await logs()).toEqual([
      { title: "Gym", source: "timer", startMs: at(9), minutes: 60 },
      { title: "Read", source: "manual", startMs: at(10), minutes: 30 },
    ]);
    // The device that made the covered log is told to drop it.
    expect((await c.useCases.pull.execute(userId, cursor)).deletes.logEntries).toEqual([covered.id]);
  });

  it("timer vs timer and manual vs manual are both kept (the device asks the user)", async () => {
    const { push, logs } = await setup();
    await push(timed("A", "timer", at(8), 60), timed("B", "timer", at(8, 30), 60));
    await push(timed("C", "manual", at(14), 60), timed("D", "manual", at(14, 30), 60));
    expect((await logs()).map((l) => `${l.title} ${l.minutes}`)).toEqual(["A 60", "B 60", "C 60", "D 60"]);
  });
});
