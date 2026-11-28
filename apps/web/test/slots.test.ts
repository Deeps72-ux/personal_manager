/**
 * SCHEDULED priority lists: saved for a future slot, applied at its start
 * (visible list + confirmed), undone at its end; the scoring timeline; and
 * the TIMER / LOG typing filter helpers.
 */
import { describe, expect, it } from "vitest";
import { effectiveHistory, inForceAt, rankDeviation, type LogEntry, type Task } from "@pm/shared";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { FolderActions, PriorityActions, SlotActions, TaskActions } from "../src/core/actions.ts";
import { filterPicks, pastActivities, planEntries, rankedList, splitPriority } from "../src/core/views.ts";

const MIN = 60_000;

function setup() {
  const store = new MemoryStore();
  const sync = { requestSync: () => undefined };
  const priority = new PriorityActions({ store, sync });
  const app = {
    store,
    tasks: new TaskActions({ store, sync }),
    folders: new FolderActions({ store, sync }),
    priority,
    slots: new SlotActions({ store, sync, priority }),
    shown: async () =>
      splitPriority(await store.listTasks(), await store.listPlacements(), await store.listFolders())
        .ranked.map((c) => `${c.task.title}${c.rank}`)
        .join(" "),
    queue: async () =>
      splitPriority(await store.listTasks(), await store.listPlacements(), await store.listFolders()).queue.map((q) => q.task.title),
    id: async (title: string) => (await store.listTasks()).find((t) => t.title === title)!.id,
    visible: async () =>
      rankedList(
        await store.listTasks(),
        (await store.listPlacements()).filter((p) => p.queuedAt == null),
        await store.listFolders(),
      ),
  };
  return app;
}

describe("effectiveHistory", () => {
  const h = (id: string, at: number, titles: string[]) => ({ id, at, titles, confirmed: true });
  const slot = (id: string, startMs: number, endMs: number, titles: string[]) => ({
    id,
    startMs,
    endMs,
    list: { entries: titles.map((title, i) => ({ title, rank: i + 1 })) },
  });

  it("a slot's list is in force during it; the order from before comes back at its end", () => {
    const t = effectiveHistory([h("a", 0, ["A"])], [slot("s", 100, 200, ["S"])]);
    expect(inForceAt(t, 50)?.titles).toEqual(["A"]);
    expect(inForceAt(t, 150)?.titles).toEqual(["S"]);
    expect(inForceAt(t, 200)?.titles).toEqual(["A"]);
  });

  it("a ✓ during the slot holds for the rest of it only; a ✓ in a gap holds after", () => {
    const t = effectiveHistory(
      [h("a", 0, ["A"]), h("in", 150, ["IN"]), h("gap", 250, ["GAP"])],
      [slot("s", 100, 200, ["S"]), slot("s2", 300, 400, ["S2"])],
    );
    expect([120, 160, 210, 260, 350, 450].map((x) => inForceAt(t, x)?.titles[0])).toEqual(["S", "IN", "A", "GAP", "S2", "GAP"]);
  });

  it("uses the snapshot a device confirmed at the start (same id) over the list as scheduled", () => {
    const t = effectiveHistory([h("s", 100, ["NEW", "S"])], [slot("s", 100, 200, ["S"])]);
    expect(inForceAt(t, 150)?.titles).toEqual(["NEW", "S"]);
    expect(inForceAt(t, 250)).toBeNull(); // nothing was confirmed before it
  });

  it("back-to-back slots: the second starts where the first ends", () => {
    const t = effectiveHistory([h("a", 0, ["A"])], [slot("s1", 100, 200, ["S1"]), slot("s2", 200, 300, ["S2"])]);
    expect([150, 200, 250, 300].map((x) => inForceAt(t, x)?.titles[0])).toEqual(["S1", "S2", "S2", "A"]);
    expect(rankDeviation("S2", inForceAt(t, 250)!.titles)).toBe(0);
  });
});

describe("slot actions", () => {
  it("refuses a start in the past, overlaps (naming the clash) and empty lists", async () => {
    const app = setup();
    await app.tasks.create({ title: "A" });
    const entries = planEntries(await app.visible());
    const now = 1_000 * MIN;
    await expect(app.slots.save({ startMs: now - MIN, endMs: now + 10 * MIN, entries }, now)).rejects.toThrow(/future/);
    await app.slots.save({ startMs: now + 10 * MIN, endMs: now + 20 * MIN, entries }, now);
    await expect(app.slots.save({ startMs: now + 15 * MIN, endMs: now + 30 * MIN, entries }, now)).rejects.toThrow(/Overlaps/);
    await expect(app.slots.save({ startMs: now + 20 * MIN, endMs: now + 30 * MIN, entries: [] }, now)).rejects.toThrow(/at least one/);
    await app.slots.save({ startMs: now + 20 * MIN, endMs: now + 30 * MIN, entries }, now); // touching is fine
    expect(await app.store.listSlots()).toHaveLength(2);
  });

  it("at its start the slot's list becomes the visible one and is confirmed; at its end the old list comes back", async () => {
    const app = setup();
    for (const t of ["C", "B", "A"]) await app.tasks.create({ title: t });
    const now = Date.now();
    expect(await app.shown()).toBe("A1 B2 C3");
    // Planned: C first, B left out.
    const plan = (await app.visible()).filter((c) => c.task.title !== "B").reverse();
    const slot = await app.slots.save({ startMs: now + 10 * MIN, endMs: now + 20 * MIN, entries: planEntries(plan).map((e, i) => ({ ...e, rank: i + 1 })) }, now);

    // Meanwhile: D is created (goes on top at the start), A is queued (comes back out).
    await new Promise((r) => setTimeout(r, 3)); // D is made in a later millisecond than the save
    await app.tasks.create({ title: "D" });
    await app.priority.enqueue(await app.id("A"));
    expect(await app.shown()).toBe("D1 B2 C3");

    expect(await app.priority.applyDueSlots(now + 10 * MIN)).toBe(true);
    expect(await app.shown()).toBe("D1 C2 A3");
    expect(await app.queue()).toEqual(["B"]);
    const snap = (await app.store.listHistory()).find((s) => s.id === slot.id)!;
    expect(snap).toMatchObject({ at: slot.startMs, titles: ["D", "C", "A"], ranks: [1, 2, 3], confirmed: true });
    expect(await app.priority.applyDueSlots(now + 11 * MIN)).toBe(false); // once

    expect(await app.priority.applyDueSlots(now + 20 * MIN)).toBe(true);
    expect(await app.shown()).toBe("D1 B2 C3");
    expect(await app.queue()).toEqual(["A"]);
    expect((await app.store.listSlots())[0]!.restored).toBe(true);
  });

  it("keeps a folder's group and its frozen rank", async () => {
    const app = setup();
    const work = await app.folders.create("Work");
    await app.tasks.create({ title: "X" });
    await app.tasks.create({ title: "W2", folderId: work });
    await app.tasks.create({ title: "W1", folderId: work });
    await app.folders.setPriority(work, 1);
    const now = Date.now();
    await app.slots.save({ startMs: now + MIN, endMs: now + 5 * MIN, entries: planEntries(await app.visible()) }, now);
    await app.folders.setPriority(work, 3); // changed after saving
    expect(await app.shown()).toBe("W13 W23 X3");
    await app.priority.applyDueSlots(now + 2 * MIN);
    expect(await app.shown()).toBe("W11 W21 X3");
  });

  it("only a future slot can be deleted; a running one can end now", async () => {
    const app = setup();
    await app.tasks.create({ title: "A" });
    const now = Date.now();
    const s = await app.slots.save({ startMs: now + MIN, endMs: now + 10 * MIN, entries: planEntries(await app.visible()) }, now);
    await app.priority.applyDueSlots(now + 2 * MIN);
    await expect(app.slots.remove(s.id, now + 2 * MIN)).rejects.toThrow(/not started/);
    await app.slots.save({ id: s.id, startMs: 0, endMs: now + 20 * MIN, entries: [] }, now + 2 * MIN); // extend
    expect((await app.store.listSlots())[0]!.endMs).toBe(now + 20 * MIN);
    await app.slots.endNow(s.id, now + 3 * MIN);
    expect((await app.store.listSlots())[0]).toMatchObject({ endMs: now + 3 * MIN, restored: true });
  });
});

describe("typing filter", () => {
  const t = (title: string, description: string | null = null): Task => ({
    id: title,
    title,
    description,
    dueDate: null,
  });
  const tasks = [t("Gym"), t("Write report"), t("Reports review"), t("Email", "reply to the report"), t("Prep")];

  it("matches title, folder name and description; best first; ';' and case ignored", () => {
    const folder = (x: Task) => (x.title === "Prep" ? "Reporting" : null);
    expect(filterPicks(tasks, "rep", folder).map((x) => x.title)).toEqual(["Reports review", "Write report", "Prep", "Email"]);
    expect(filterPicks(tasks, "GYM;", folder).map((x) => x.title)).toEqual(["Gym"]);
    expect(filterPicks(tasks, " ", folder)).toHaveLength(5);
  });

  it("suggests activities logged before that are not tasks, most recent first", () => {
    const log = (title: string, startMs: number): LogEntry => ({
      id: `${title}${startMs}`,
      day: "2026-11-28",
      seconds: 60,
      taskTitle: title,
      startMs,
    });
    const logs = [log("Lunch", 1), log("Lunch break", 5), log("Gym", 9), log("Walk", 3)];
    expect(pastActivities(logs, tasks, "lun")).toEqual(["Lunch break", "Lunch"]);
    expect(pastActivities(logs, tasks, "gym")).toEqual([]);
    expect(pastActivities(logs, tasks, "")).toEqual([]);
  });
});
