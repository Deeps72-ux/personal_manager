/**
 * PRIORITY ranks: typed on a card or given by a folder, ties allowed; erased
 * by drags, the queue and new tasks; scored by step among the ranks in use.
 */
import { describe, expect, it } from "vitest";
import { rankDeviation, topTitles, type Folder, type Placement, type Task } from "@pm/shared";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { FolderActions, PriorityActions, TaskActions } from "../src/core/actions.ts";
import { rankedList, splitPriority } from "../src/core/views.ts";

const task = (id: string, folderId: string | null = null): Task => ({
  id,
  title: id,
  description: null,
  dueDate: null,
  folderId,
  folderRank: "a0",
});
const place = (taskId: string, rank: string, userRank?: number): Placement => ({ taskId, rank, ...(userRank ? { userRank } : {}) });
const folder = (id: string, parentId: string | null, priority?: number): Folder => ({
  id,
  name: id,
  parentId,
  rank: "a0",
  ...(priority ? { priority } : {}),
});
const shown = (cards: ReturnType<typeof rankedList>) => cards.map((c) => `${c.task.id}${c.rank}`).join(" ");

describe("rankedList", () => {
  it("ranks by position until a rank is typed; a typed card moves, the others keep their numbers", () => {
    const tasks = ["A", "B", "C", "D"].map((id) => task(id));
    const plain = ["A", "B", "C", "D"].map((id, i) => place(id, `a${i}`));
    expect(shown(rankedList(tasks, plain, []))).toBe("A1 B2 C3 D4");
    const typed = plain.map((p) => (p.taskId === "D" ? { ...p, userRank: 1 } : p));
    expect(shown(rankedList(tasks, typed, []))).toBe("A1 D1 B2 C3");
  });

  it("a folder's rank goes to every task inside it, nested too; the nearest ranked folder wins, over a typed rank", () => {
    const tasks = [task("X"), task("Y"), task("Z"), task("W1", "work"), task("W2", "deep"), task("H", "home")];
    const placements = ["X", "Y", "Z", "W1", "W2", "H"].map((id, i) => place(id, `a${i}`, id === "W2" ? 5 : undefined));
    const folders = [folder("work", null, 1), folder("deep", "work"), folder("home", null, 2), folder("inner", "home", 1)];
    // W2 sits in Deep (no rank) inside Work (1): Work wins over W2's typed 5.
    // Ties: folder-ranked cards first.
    expect(shown(rankedList(tasks, placements, folders))).toBe("W11 W21 X1 H2 Y2 Z3");
    // Deep gets its own rank: it is nearer to W2 than Work.
    const deeper = rankedList(tasks, placements, [folder("work", null, 1), folder("deep", "work", 3)]);
    expect(deeper.find((c) => c.task.id === "W2")).toMatchObject({ rank: 3, source: "folder", folderId: "deep" });
  });
});

describe("scoring with ranks", () => {
  it("ties score the same; gaps don't count (step among the ranks in use)", () => {
    const titles = ["A", "B", "C", "D"];
    const ranks = [1, 1, 1, 4];
    expect(rankDeviation("B", titles, ranks)).toBe(0);
    expect(rankDeviation("D", titles, ranks)).toBeCloseTo(100 / 3);
    expect(rankDeviation("Other", titles, ranks)).toBeCloseTo(200 / 3);
    // Older snapshots (no ranks): positions, as before.
    expect(rankDeviation("D", titles)).toBe(60);
    expect(topTitles(titles, ranks)).toBe("A, B, C");
    expect(topTitles(titles)).toBe("A");
  });
});

function setup() {
  const store = new MemoryStore();
  const sync = { requestSync: () => undefined };
  const app = {
    store,
    tasks: new TaskActions({ store, sync }),
    folders: new FolderActions({ store, sync }),
    priority: new PriorityActions({ store, sync }),
    shown: async () =>
      splitPriority(await store.listTasks(), await store.listPlacements(), await store.listFolders())
        .ranked.map((c) => `${c.task.title}${c.rank}`)
        .join(" "),
    id: async (title: string) => (await store.listTasks()).find((t) => t.title === title)!.id,
    ops: async () => (await store.listOutbox()).map((c) => c.op),
    ownRank: async (title: string) => {
      const id = (await store.listTasks()).find((t) => t.title === title)!.id;
      return !!(await store.listPlacements()).find((p) => p.taskId === id)?.ownRank;
    },
  };
  return app;
}

describe("rank actions", () => {
  it("typing a rank: 1 up to the number of cards; clear goes back to the position", async () => {
    const app = setup();
    for (const t of ["D", "C", "B", "A"]) await app.tasks.create({ title: t });
    await app.priority.setRank(await app.id("D"), 1);
    await app.priority.setRank(await app.id("C"), 1);
    expect(await app.shown()).toBe("A1 C1 D1 B2");
    await expect(app.priority.setRank(await app.id("A"), 5)).rejects.toThrow("from 1 to 4");
    await expect(app.priority.setRank(await app.id("A"), 0)).rejects.toThrow("from 1 to 4");
    await app.priority.setRank(await app.id("C"), null);
    expect(await app.shown()).toBe("A1 D1 B2 C3");
  });

  it("a drag, the queue, a returning task and a new task each erase typed ranks; positions become what was shown", async () => {
    const app = setup();
    for (const t of ["D", "C", "B", "A"]) await app.tasks.create({ title: t });
    await app.priority.setRank(await app.id("D"), 1); // A1 D1 B2 C3
    await app.priority.move(await app.id("C"), 0);
    expect(await app.shown()).toBe("C1 A2 D3 B4");
    expect(await app.ops()).toContain("clearTaskRanks");

    await app.priority.setRank(await app.id("B"), 1); // C1 B1 A2 D3
    await app.priority.enqueue(await app.id("A"));
    expect(await app.shown()).toBe("C1 B2 D3");
    await app.priority.setRank(await app.id("D"), 1);
    await app.priority.dequeue(await app.id("A"));
    expect(await app.shown()).toBe("A1 C2 D3 B4");
    await app.priority.setRank(await app.id("B"), 1);
    await app.tasks.create({ title: "E" });
    expect(await app.shown()).toBe("E1 A2 B3 C4 D5");
  });

  it("folder ranks survive drags; reordering inside the group erases nothing; a card dragged out leaves its group alone", async () => {
    const app = setup();
    const work = await app.folders.create("Work");
    for (const t of ["Z", "Y", "X"]) await app.tasks.create({ title: t });
    await app.tasks.create({ title: "W2", folderId: work });
    await app.tasks.create({ title: "W1", folderId: work });
    // W1 W2 X Y Z by position; give Work rank 3 → W1 3, W2 3 (others keep numbers).
    await app.folders.setPriority(work, 3);
    expect(await app.shown()).toBe("W13 W23 X3 Y4 Z5");
    await app.priority.setRank(await app.id("Z"), 1);
    expect(await app.shown()).toBe("Z1 W13 W23 X3 Y4");

    // Inside the group: W2 above W1; Z keeps its typed rank, Work keeps 3.
    await app.priority.move(await app.id("W2"), 1);
    expect(await app.shown()).toBe("Z1 W23 W13 X3 Y4");
    expect((await app.store.listFolders())[0]!.priority).toBe(3);

    // A plain card dragged: typed ranks go, the folder rank stays.
    await app.priority.move(await app.id("Y"), 0);
    expect(await app.shown()).toBe("Y1 Z2 W23 W13 X5");

    // W1 dragged out of its group to the top: only W1 leaves; Work moves down a step (3 → 4).
    await app.priority.move(await app.id("W1"), 0);
    expect(await app.shown()).toBe("W11 Y2 Z3 W24 X5");
    expect((await app.store.listFolders())[0]!.priority).toBe(4);
    expect(await app.ownRank("W1")).toBe(true);

    // Another drag: W1 keeps its place as its own rank.
    await app.priority.move(await app.id("X"), 1);
    expect(await app.shown()).toBe("W11 X2 Y3 Z4 W25");
    expect((await app.store.listFolders())[0]!.priority).toBe(5);

    // Dragged back next to W2: it rejoins Work.
    await app.priority.move(await app.id("W1"), 4);
    expect(await app.shown()).toBe("X1 Y2 Z3 W24 W14");
    expect(await app.ownRank("W1")).toBe(false);
  });

  it("a card dropped above a folder's group beats it: the group and everything below move down a step", async () => {
    const app = setup();
    const a = await app.folders.create("A");
    const b = await app.folders.create("B");
    for (const t of ["X", "P"]) await app.tasks.create({ title: t });
    await app.tasks.create({ title: "B1", folderId: b });
    await app.tasks.create({ title: "A2", folderId: a });
    await app.tasks.create({ title: "A1", folderId: a });
    await app.folders.setPriority(a, 1);
    await app.folders.setPriority(b, 3);
    expect(await app.shown()).toBe("A11 A21 B13 P4 X5");

    await app.priority.move(await app.id("X"), 0);
    expect(await app.shown()).toBe("X1 A12 A22 B14 P5");
    const rank = async (id: string) => (await app.store.listFolders()).find((f) => f.id === id)!.priority;
    expect(await rank(a)).toBe(2);
    expect(await rank(b)).toBe(4);
    const last = await app.priority.confirm(5000);
    expect(last).toBe(true);
    expect((await app.store.listHistory()).at(-1)!.ranks).toEqual([1, 2, 2, 4, 5]);
  });

  it("dropped between two tied cards of a folder, a card shares their rank", async () => {
    const app = setup();
    const a = await app.folders.create("A");
    for (const t of ["X", "P"]) await app.tasks.create({ title: t });
    await app.tasks.create({ title: "A2", folderId: a });
    await app.tasks.create({ title: "A1", folderId: a });
    await app.folders.setPriority(a, 1);
    expect(await app.shown()).toBe("A11 A21 P3 X4");
    await app.priority.move(await app.id("X"), 1);
    expect(await app.shown()).toBe("A11 A21 X1 P4");
  });

  it("a card of another ranked folder dropped on top leaves only itself; its folder keeps its group, a step lower", async () => {
    const app = setup();
    const a = await app.folders.create("A");
    const b = await app.folders.create("B");
    await app.tasks.create({ title: "B2", folderId: b });
    await app.tasks.create({ title: "B1", folderId: b });
    await app.tasks.create({ title: "A1", folderId: a });
    await app.folders.setPriority(a, 1);
    await app.folders.setPriority(b, 2);
    expect(await app.shown()).toBe("A11 B12 B22");
    await app.priority.move(await app.id("B2"), 0);
    expect(await app.shown()).toBe("B21 A12 B13");
    const rank = async (id: string) => (await app.store.listFolders()).find((f) => f.id === id)!.priority;
    expect([await rank(a), await rank(b)]).toEqual([2, 3]);
  });

  it("confirm snapshots the ranks; a rank edit makes the order confirmable again", async () => {
    const app = setup();
    for (const t of ["C", "B", "A"]) await app.tasks.create({ title: t });
    expect(await app.priority.confirm(1000)).toBe(true);
    expect(await app.priority.confirm(2000)).toBe(false);
    await app.priority.setRank(await app.id("C"), 1);
    expect(await app.priority.confirm(3000)).toBe(true);
    const last = (await app.store.listHistory()).at(-1)!;
    expect(last.titles).toEqual(["A", "C", "B"]);
    expect(last.ranks).toEqual([1, 1, 2]);
  });
});
