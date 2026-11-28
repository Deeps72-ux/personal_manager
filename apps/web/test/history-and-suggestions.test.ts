/**
 * PAST PRIORITY LISTS by time (LOG → a day → Priority), restoring or
 * rescheduling one; hiding past activities from the suggestion chips; the
 * edge speed of drag auto-scroll.
 */
import { describe, expect, it } from "vitest";
import { uuidv7, type LogEntry, type Task } from "@pm/shared";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { LogActions, PriorityActions, SlotActions, TaskActions } from "../src/core/actions.ts";
import { listFromTitles, periodList, periodsForDay, priorityPeriods } from "../src/core/periods.ts";
import { activityStats, pastActivities, splitPriority } from "../src/core/views.ts";
import { edgeSpeed, MAX_SPEED } from "../src/ui/drag-autoscroll.ts";

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();

function setup() {
  const store = new MemoryStore();
  const sync = { requestSync: () => undefined };
  const priority = new PriorityActions({ store, sync });
  return {
    store,
    priority,
    tasks: new TaskActions({ store, sync }),
    slots: new SlotActions({ store, sync, priority }),
    logs: new LogActions({ store, sync }),
    shown: async () =>
      splitPriority(await store.listTasks(), await store.listPlacements(), await store.listFolders())
        .ranked.map((c) => `${c.task.title}${c.rank}`)
        .join(" "),
    id: async (title: string) => (await store.listTasks()).find((t) => t.title === title)!.id,
    periods: async (now: number) => priorityPeriods(await store.listHistory(), await store.listSlots(), now),
  };
}

describe("past priority lists by time", () => {
  it("each list runs until the next took over; a slot, the list back after it, and slots still to come", async () => {
    const app = setup();
    for (const t of ["C", "B", "A"]) await app.tasks.create({ title: t });
    await app.priority.confirm(at(20, 8)); // A B C from 08:00
    const entries = [{ taskId: await app.id("C"), title: "C", rank: 1, folderId: null }];
    await app.slots.save({ startMs: at(20, 9), endMs: at(20, 11, 34), entries }, at(20, 8, 30));
    await app.slots.save({ startMs: at(20, 15), endMs: at(20, 16), entries }, at(20, 8, 30));
    await app.priority.applyDueSlots(at(20, 9));
    await app.priority.applyDueSlots(at(20, 11, 34));

    const now = at(20, 12);
    const ps = await app.periods(now);
    const show = ps.map((p) => `${p.kind} ${new Date(p.fromMs).getHours()}-${p.toMs === null ? "now" : new Date(p.toMs).getHours()} ${p.titles.join("")}`);
    expect(show).toEqual(["confirm 8-9 ABC", "slot 9-11 C", "back 11-now ABC", "scheduled 15-16 C"]);
    expect(ps[2]!.slotId).toBe(ps[1]!.slotId);

    // Cut at midnight, like logs: still in force the next morning.
    const tomorrow = periodsForDay(ps, "2026-11-21", at(21, 8));
    expect(tomorrow.map((x) => [x.period.kind, x.start === at(21, 0), x.cutStart])).toEqual([["back", true, true]]);
    const today = periodsForDay(ps, "2026-11-20", at(21, 8));
    expect(today.find((x) => x.period.kind === "back")).toMatchObject({ end: at(21, 0), cutEnd: true });
    expect(periodsForDay(ps, "2026-11-19", now)).toEqual([]);
  });

  it("restore as current: the old list comes back shown, NOT confirmed; deleted tasks drop out, new ones go on top", async () => {
    const app = setup();
    for (const t of ["C", "B", "A"]) await app.tasks.create({ title: t });
    await app.priority.confirm(at(20, 8)); // A1 B2 C3
    await app.priority.move(await app.id("C"), 0);
    await app.priority.confirm(at(20, 10)); // C1 A2 B3
    await app.tasks.remove(await app.id("B"));
    await new Promise((r) => setTimeout(r, 3));
    await app.tasks.create({ title: "D" });
    expect(await app.shown()).toBe("D1 C2 A3");

    const first = (await app.periods(at(20, 12)))[0]!;
    const list = periodList(first, [], await app.store.listTasks(), new Map());
    expect(list.entries.map((e) => e.title)).toEqual(["A", "C"]); // B was deleted
    const history = (await app.store.listHistory()).length;
    await app.priority.restoreList(list, at(20, 12));
    expect(await app.shown()).toBe("D1 A2 C3");
    expect((await app.store.listHistory()).length).toBe(history); // ✓ still needed
  });

  it("matching titles: duplicates take one task each; a folder's tied cards keep the folder's rank", () => {
    const t = (id: string, title: string) => ({ id, title });
    const tasks = [t("1", "Gym"), t("2", "Read"), t("3", "Read"), t("4", "W1"), t("5", "W2")];
    const home = new Map([["4", "work"], ["5", "work"]]);
    const list = listFromTitles(["W1", "W2", "read", "Read", "Gone"], [1, 1, 2, 3, 4], tasks, home, 0);
    expect(list.entries.map((e) => `${e.taskId}:${e.rank}:${e.folderId}`)).toEqual(["4:1:work", "5:1:work", "2:2:null", "3:3:null"]);
    const split = listFromTitles(["W1", "W2"], [1, 2], tasks, home, 0);
    expect(split.entries.map((e) => e.folderId)).toEqual([null, null]);
  });
});

describe("hiding past activities from the chips", () => {
  const tasks: Task[] = [{ id: uuidv7(), title: "Gym", description: null, dueDate: null }];
  const log = (title: string, created: number, startMs = created): LogEntry => ({
    id: uuidv7(created),
    day: "2026-11-20",
    seconds: 60,
    taskTitle: title,
    startMs,
  });

  it("hidden by name (any case) until logged again; logs keep their names", async () => {
    const app = setup();
    const logs = [log("Lunch", 1000), log("lunch break", 2000), log("Walk", 3000)];
    expect(pastActivities(logs, tasks, "l")).toEqual(["lunch break", "Lunch", "Walk"]);

    await app.logs.hideActivities(["LUNCH"], 5000);
    let hidden = await app.store.listHidden();
    expect(pastActivities(logs, tasks, "l", 8, hidden)).toEqual(["lunch break", "Walk"]);
    // Hiding it again replaces the old record (one per name).
    await app.logs.hideActivities(["lunch"], 6000);
    hidden = await app.store.listHidden();
    expect(hidden).toHaveLength(1);
    expect((await app.store.listOutbox()).map((c) => c.op)).toEqual(["hideActivity", "unhideActivity", "hideActivity"]);

    // Logging it again (an older time of day, made later) brings it back.
    const again = [...logs, log("Lunch", 7000, 500)];
    expect(pastActivities(again, tasks, "l", 8, hidden)).toContain("Lunch");

    // Manage list: counts, last used, hidden flag; bring back.
    expect(activityStats(logs, tasks, hidden).map((a) => `${a.title}:${a.count}:${a.hidden}`)).toEqual([
      "Walk:1:false",
      "lunch break:1:false",
      "Lunch:1:true",
    ]);
    await app.logs.unhideActivities(["Lunch"]);
    expect(await app.store.listHidden()).toEqual([]);
    expect(pastActivities(logs, tasks, "lun", 8, [])).toEqual(["lunch break", "Lunch"]);
  });
});

describe("drag auto-scroll speed", () => {
  it("scrolls up near the top, down near the bottom, faster closer to the edge, not in the middle", () => {
    expect(edgeSpeed(500, 100, 900)).toBe(0);
    expect(edgeSpeed(100, 100, 900)).toBe(-MAX_SPEED);
    expect(edgeSpeed(40, 100, 900)).toBe(-MAX_SPEED); // past the edge: full speed
    expect(edgeSpeed(900, 100, 900)).toBe(MAX_SPEED);
    const near = edgeSpeed(120, 100, 900);
    const far = edgeSpeed(170, 100, 900);
    expect(near).toBeLessThan(far);
    expect(far).toBeLessThan(0);
    expect(edgeSpeed(880, 100, 900)).toBeGreaterThan(edgeSpeed(830, 100, 900));
  });
});

