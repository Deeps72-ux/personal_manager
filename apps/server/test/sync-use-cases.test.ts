/**
 * Use-case tests through the real SQLite adapter (in memory), with a fake
 * clock. Covers what is awkward to reach over HTTP: retention, paging,
 * snapshot fallbacks.
 */
import { describe, expect, it } from "vitest";
import { ch, log, newUser, task, testContainer } from "./helpers.ts";

describe("PushChanges handlers", () => {
  it("createTask is idempotent and writes task + placement", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const t = task("Gym");
    const change = ch({ op: "createTask", task: t, rank: "a0" });
    expect((await c.useCases.push.execute(userId, [change])).results[0]!.status).toBe("applied");
    expect((await c.useCases.push.execute(userId, [change])).results[0]!.status).toBe("applied"); // resend
    const snap = await c.useCases.pull.execute(userId, 0);
    expect(snap.upserts.tasks).toEqual([t]);
    expect(snap.upserts.placements).toEqual([{ taskId: t.id, rank: "a0" }]);
  });

  it("applies a batch in order (create then rename in one push)", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const t = task("Gym");
    await c.useCases.push.execute(userId, [
      ch({ op: "createTask", task: t, rank: "a0" }),
      ch({ op: "updateTask", taskId: t.id, patch: { title: "Workout" } }),
    ]);
    expect((await c.useCases.pull.execute(userId, 0)).upserts.tasks[0]!.title).toBe("Workout");
  });

  it("a failing change rolls back the whole push", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const t = task("Gym");
    // Bypass schema validation to force a DB CHECK failure (seconds > 86400).
    const bad = ch({ op: "createLog", entry: { ...log("2026-11-05", 1, "x"), seconds: 999_999 } });
    await expect(c.useCases.push.execute(userId, [ch({ op: "createTask", task: t, rank: "a0" }), bad])).rejects.toThrow();
    expect((await c.useCases.pull.execute(userId, 0)).upserts.tasks).toEqual([]);
  });

  it("deleteTask removes task + placement but never logs", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const t = task("Gym");
    const l = log("2026-11-05", 3600, "Gym");
    await c.useCases.push.execute(userId, [ch({ op: "createTask", task: t, rank: "a0" }), ch({ op: "createLog", entry: l })]);
    const r = await c.useCases.push.execute(userId, [ch({ op: "deleteTask", taskId: t.id })]);
    expect(r.results[0]!.status).toBe("applied");
    const snap = await c.useCases.pull.execute(userId, 0);
    expect(snap.upserts.tasks).toEqual([]);
    expect(snap.upserts.placements).toEqual([]);
    expect(snap.upserts.logEntries).toEqual([l]);
  });

  it("edits/moves after delete are ignored as 'deleted'; unknown ids as 'notFound'", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const t = task("Gym");
    await c.useCases.push.execute(userId, [ch({ op: "createTask", task: t, rank: "a0" }), ch({ op: "deleteTask", taskId: t.id })]);
    const r = await c.useCases.push.execute(userId, [
      ch({ op: "updateTask", taskId: t.id, patch: { title: "x" } }),
      ch({ op: "moveTask", taskId: t.id, rank: "a1" }),
      ch({ op: "createTask", task: t, rank: "a0" }), // late resend must not resurrect
      ch({ op: "updateTask", taskId: task("never").id, patch: { title: "x" } }),
      ch({ op: "deleteTask", taskId: t.id }),
    ]);
    expect(r.results.map((x) => (x.status === "ignored" ? x.reason : x.status))).toEqual([
      "deleted",
      "deleted",
      "deleted",
      "notFound",
      "notFound",
    ]);
  });

  it("no 24h check on the server (UI-only rule)", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const r = await c.useCases.push.execute(userId, [
      ch({ op: "createLog", entry: log("2026-11-05", 72_000, "phone") }),
      ch({ op: "createLog", entry: log("2026-11-05", 72_000, "laptop") }),
    ]);
    expect(r.results.every((x) => x.status === "applied")).toBe(true);
  });

  it("purge deletes older logs, arms the guard, and the guard only moves forward", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const old = log("2025-12-20", 60, "old");
    const keep = log("2026-01-01", 60, "keep");
    await c.useCases.push.execute(userId, [ch({ op: "createLog", entry: old }), ch({ op: "createLog", entry: keep })]);
    await c.useCases.push.execute(userId, [ch({ op: "purgeLogsBefore", before: "2026-01-01" })]);
    await c.useCases.push.execute(userId, [ch({ op: "purgeLogsBefore", before: "2025-06-01" })]); // older: no-op
    const snap = await c.useCases.pull.execute(userId, 0);
    expect(snap.upserts.logEntries).toEqual([keep]);
    expect(snap.purgedBefore).toBe("2026-01-01");

    const late = await c.useCases.push.execute(userId, [ch({ op: "createLog", entry: log("2025-12-31", 5, "late") })]);
    expect(late.results[0]).toMatchObject({ status: "ignored", reason: "purged" });
  });

  it("notifies only when something was applied, after commit", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const seen: number[] = [];
    c.hub.subscribe(userId, (cursor) => seen.push(cursor));
    await c.useCases.push.execute(userId, [ch({ op: "deleteLog", logId: log("2026-11-05", 1, "x").id })]);
    expect(seen).toEqual([]);
    await c.useCases.push.execute(userId, [ch({ op: "createLog", entry: log("2026-11-05", 1, "x") })]);
    expect(seen).toHaveLength(1);
  });
});

describe("PullChanges", () => {
  it("incremental pull collapses multiple edits of a row into its latest state", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const t = task("Gym");
    await c.useCases.push.execute(userId, [ch({ op: "createTask", task: t, rank: "a0" })]);
    const { cursor } = await c.useCases.pull.execute(userId, 0);
    await c.useCases.push.execute(userId, [
      ch({ op: "updateTask", taskId: t.id, patch: { title: "A" } }),
      ch({ op: "updateTask", taskId: t.id, patch: { title: "B" } }),
    ]);
    const inc = await c.useCases.pull.execute(userId, cursor);
    expect(inc.mode).toBe("incremental");
    expect(inc.upserts.tasks).toEqual([{ ...t, title: "B" }]);
    expect(inc.cursor).toBeGreaterThan(cursor);
  });

  it("create-then-delete inside one page yields only the delete", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    await c.useCases.push.execute(userId, [ch({ op: "createTask", task: task("seed"), rank: "a0" })]);
    const { cursor } = await c.useCases.pull.execute(userId, 0);
    const t = task("temp");
    await c.useCases.push.execute(userId, [ch({ op: "createTask", task: t, rank: "a1" }), ch({ op: "deleteTask", taskId: t.id })]);
    const inc = await c.useCases.pull.execute(userId, cursor);
    expect(inc.upserts.tasks).toEqual([]);
    expect(inc.deletes.tasks).toEqual([t.id]);
  });

  it("pages with hasMore and resumes from the returned cursor", async () => {
    const c = testContainer({ pullPageSize: 3 });
    const { userId } = await newUser(c);
    await c.useCases.push.execute(userId, [ch({ op: "createLog", entry: log("2026-11-01", 1, "seed") })]);
    let { cursor } = await c.useCases.pull.execute(userId, 0);
    const entries = Array.from({ length: 7 }, (_, i) => log("2026-11-05", i + 1, `t${i}`));
    await c.useCases.push.execute(userId, entries.map((e) => ch({ op: "createLog", entry: e })));

    const got: string[] = [];
    let pages = 0;
    for (;;) {
      const page = await c.useCases.pull.execute(userId, cursor);
      pages++;
      got.push(...page.upserts.logEntries.map((e) => e.taskTitle));
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    expect(pages).toBe(3);
    // Order inside a page is not meaningful; every entry must arrive exactly once.
    expect(got.sort()).toEqual(entries.map((e) => e.taskTitle).sort());
  });

  it("falls back to snapshot when the cursor is older than retained history", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const t = task("Gym");
    await c.useCases.push.execute(userId, [ch({ op: "createTask", task: t, rank: "a0" })]);
    const { cursor } = await c.useCases.pull.execute(userId, 0);

    await c.useCases.push.execute(userId, [ch({ op: "deleteTask", taskId: t.id })]);
    c.clock.advanceDays(31);
    await c.useCases.push.execute(userId, [ch({ op: "createTask", task: task("New"), rank: "a0" })]);
    const cleaned = await c.useCases.cleanup.execute();
    expect(cleaned.changeLogRows).toBeGreaterThan(0);

    // The device missed the delete record (cleaned up) → must get a snapshot.
    const r = await c.useCases.pull.execute(userId, cursor);
    expect(r.mode).toBe("snapshot");
    expect(r.upserts.tasks.map((x) => x.title)).toEqual(["New"]);
  });

  it("snapshot when the cursor is ahead of the server (restored backup)", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    expect((await c.useCases.pull.execute(userId, 999)).mode).toBe("snapshot");
  });

  it("an up-to-date device gets an empty incremental page", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    await c.useCases.push.execute(userId, [ch({ op: "createTask", task: task("Gym"), rank: "a0" })]);
    const { cursor } = await c.useCases.pull.execute(userId, 0);
    const r = await c.useCases.pull.execute(userId, cursor);
    expect(r).toMatchObject({ mode: "incremental", cursor, hasMore: false });
    expect(r.upserts.tasks).toEqual([]);
  });
});

describe("isolation", () => {
  it("two users with the SAME task id never see or touch each other's rows", async () => {
    const c = testContainer();
    const a = await newUser(c);
    const b = await newUser(c);
    const t = task("A's secret");
    await c.useCases.push.execute(a.userId, [ch({ op: "createTask", task: t, rank: "a0" })]);
    await c.useCases.push.execute(b.userId, [ch({ op: "createTask", task: { ...t, title: "B's own" }, rank: "a0" })]);
    const r = await c.useCases.push.execute(b.userId, [ch({ op: "updateTask", taskId: t.id, patch: { title: "hacked" } })]);
    expect(r.results[0]!.status).toBe("applied"); // applied to B's OWN row

    const snapA = await c.useCases.pull.execute(a.userId, 0);
    const snapB = await c.useCases.pull.execute(b.userId, 0);
    expect(snapA.upserts.tasks.map((x) => x.title)).toEqual(["A's secret"]);
    expect(snapB.upserts.tasks.map((x) => x.title)).toEqual(["hacked"]);
  });

  it("a user's incremental pull never includes another user's changes", async () => {
    const c = testContainer();
    const a = await newUser(c);
    const b = await newUser(c);
    const { cursor } = await c.useCases.pull.execute(a.userId, 0);
    await c.useCases.push.execute(b.userId, [ch({ op: "createLog", entry: log("2026-11-05", 5, "B only") })]);
    const r = await c.useCases.pull.execute(a.userId, cursor === 0 ? 0 : cursor);
    expect(r.upserts.logEntries).toEqual([]);
  });
});
