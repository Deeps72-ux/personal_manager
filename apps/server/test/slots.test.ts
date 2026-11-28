/** SCHEDULED priority lists and own card ranks on the server. */
import { describe, expect, it } from "vitest";
import { uuidv7, type PrioritySlot } from "@pm/shared";
import { ch, newUser, task, testContainer } from "./helpers.ts";

describe("slot ops", () => {
  it("saveSlot upserts the whole row, deleteSlot removes it, both reach other devices", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const a = task("A");
    await c.useCases.push.execute(userId, [ch({ op: "createTask", task: a, rank: "a0" })]);
    const cursor = (await c.useCases.pull.execute(userId, 0)).cursor;

    const slot: PrioritySlot = {
      id: uuidv7(),
      startMs: 1_000_000,
      endMs: 2_000_000,
      list: { savedAt: 10, entries: [{ taskId: a.id, title: "A", rank: 1, folderId: null }] },
    };
    await c.useCases.push.execute(userId, [ch({ op: "saveSlot", slot })]);
    let inc = await c.useCases.pull.execute(userId, cursor);
    expect(inc.upserts.prioritySlots).toEqual([slot]);

    const restored = { ...slot, endMs: 1_500_000, restore: { savedAt: 20, entries: [] }, restored: true };
    await c.useCases.push.execute(userId, [ch({ op: "saveSlot", slot: restored })]);
    expect((await c.useCases.pull.execute(userId, 0)).upserts.prioritySlots).toEqual([restored]);

    const before = (await c.useCases.pull.execute(userId, 0)).cursor;
    const res = await c.useCases.push.execute(userId, [
      ch({ op: "deleteSlot", slotId: slot.id }),
      ch({ op: "deleteSlot", slotId: slot.id }),
      ch({ op: "saveSlot", slot }), // an old edit arriving late does not bring it back
    ]);
    expect(res.results.map((r) => r.status)).toEqual(["applied", "ignored", "ignored"]);
    inc = await c.useCases.pull.execute(userId, before);
    expect(inc.deletes.prioritySlots).toEqual([slot.id]);
    expect((await c.useCases.pull.execute(userId, 0)).upserts.prioritySlots).toEqual([]);
  });

  it("setTaskOwnRank is stored on the placement", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const a = task("A");
    await c.useCases.push.execute(userId, [
      ch({ op: "createTask", task: a, rank: "a0" }),
      ch({ op: "setTaskOwnRank", taskId: a.id, ownRank: true }),
    ]);
    expect((await c.useCases.pull.execute(userId, 0)).upserts.placements).toEqual([
      { taskId: a.id, rank: "a0", queuedAt: null, ownRank: true },
    ]);
    const res = await c.useCases.push.execute(userId, [ch({ op: "setTaskOwnRank", taskId: uuidv7(), ownRank: true })]);
    expect(res.results[0]!.status).toBe("ignored");
  });
});

describe("hidden activity ops", () => {
  it("hideActivity / unhideActivity reach other devices; a late hide does not bring a removed one back", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const cursor = (await c.useCases.pull.execute(userId, 0)).cursor;
    const hidden = { id: uuidv7(), name: "Lunch", hiddenAt: 5000 };
    await c.useCases.push.execute(userId, [ch({ op: "hideActivity", hidden })]);
    const inc = await c.useCases.pull.execute(userId, cursor);
    expect(inc.upserts.hiddenActivities).toEqual([hidden]);
    expect((await c.useCases.pull.execute(userId, 0)).upserts.hiddenActivities).toEqual([hidden]);

    const before = inc.cursor;
    const res = await c.useCases.push.execute(userId, [
      ch({ op: "unhideActivity", hiddenId: hidden.id }),
      ch({ op: "unhideActivity", hiddenId: hidden.id }),
      ch({ op: "hideActivity", hidden }),
    ]);
    expect(res.results.map((r) => r.status)).toEqual(["applied", "ignored", "ignored"]);
    expect((await c.useCases.pull.execute(userId, before)).deletes.hiddenActivities).toEqual([hidden.id]);
    expect((await c.useCases.pull.execute(userId, 0)).upserts.hiddenActivities).toEqual([]);
  });
});
