/** PRIORITY ranks on the server: typed card ranks, their erase, folder ranks, ranked snapshots. */
import { describe, expect, it } from "vitest";
import { uuidv7, type Folder } from "@pm/shared";
import { ch, newUser, task, testContainer } from "./helpers.ts";

const folder = (name: string): Folder => ({ id: uuidv7(), name, parentId: null, rank: "a0", top: false });

describe("rank ops", () => {
  it("setTaskRank, clearTaskRanks and setFolderPriority reach other devices; snapshots keep their ranks", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const a = task("A");
    const b = task("B");
    const work = folder("Work");
    await c.useCases.push.execute(userId, [
      ch({ op: "createTask", task: a, rank: "a0" }),
      ch({ op: "createTask", task: b, rank: "a1" }),
      ch({ op: "createFolder", folder: work }),
    ]);
    const cursor = (await c.useCases.pull.execute(userId, 0)).cursor;

    const res = await c.useCases.push.execute(userId, [
      ch({ op: "setTaskRank", taskId: b.id, userRank: 1 }),
      ch({ op: "setFolderPriority", folderId: work.id, priority: 2 }),
      ch({ op: "recordPriority", snapshot: { id: uuidv7(), at: 5, titles: ["A", "B"], ranks: [1, 1], confirmed: true } }),
      ch({ op: "setTaskRank", taskId: uuidv7(), userRank: 1 }),
    ]);
    expect(res.results.map((r) => r.status)).toEqual(["applied", "applied", "applied", "ignored"]);
    const inc = await c.useCases.pull.execute(userId, cursor);
    expect(inc.upserts.placements).toEqual([{ taskId: b.id, rank: "a1", queuedAt: null, userRank: 1 }]);
    expect(inc.upserts.folders).toEqual([{ ...work, priority: 2 }]);
    expect(inc.upserts.priorityHistory[0]).toMatchObject({ titles: ["A", "B"], ranks: [1, 1] });

    const before = inc.cursor;
    await c.useCases.push.execute(userId, [
      ch({ op: "clearTaskRanks" }),
      ch({ op: "setFolderPriority", folderId: work.id, priority: null }),
    ]);
    const cleared = await c.useCases.pull.execute(userId, before);
    expect(cleared.upserts.placements).toEqual([{ taskId: b.id, rank: "a1", queuedAt: null }]);
    expect(cleared.upserts.folders).toEqual([work]);
  });
});
