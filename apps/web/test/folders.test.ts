/**
 * TASKS-tab FOLDERS on the device: the tree (robust to rows from devices
 * that were apart) and the folder actions.
 */
import { describe, expect, it } from "vitest";
import { uuidv7, type Folder, type Task } from "@pm/shared";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { FolderActions, PriorityActions, TaskActions } from "../src/core/actions.ts";
import { applyChangeLocally } from "../src/core/apply-change.ts";
import { buildFolderTree } from "../src/core/folders.ts";
import { priorityOrder } from "../src/core/views.ts";

const folder = (id: string, parentId: string | null, rank = "a0", top = false): Folder => ({ id, name: id, parentId, rank, top });
const task = (id: string, folderId: string | null, folderRank: string | null, folderTop = false): Task => ({
  id,
  title: id,
  description: null,
  dueDate: null,
  folderId,
  folderRank,
  folderTop,
});

describe("buildFolderTree", () => {
  it("nests, orders by rank, counts tasks at any depth, gives the path", () => {
    const tree = buildFolderTree(
      [folder("b", null, "a1"), folder("a", null, "a0"), folder("a1", "a"), folder("a11", "a1")],
      [task("t1", "a11", "a0"), task("t2", "a", "a1"), task("t3", "a", "a0"), task("t4", null, "a0")],
    );
    expect(tree.folders(null).map((f) => f.id)).toEqual(["a", "b"]);
    expect(tree.tasks("a").map((t) => t.id)).toEqual(["t3", "t2"]);
    expect(tree.taskCount("a")).toBe(3);
    expect(tree.path("a11").map((f) => f.id)).toEqual(["a", "a1", "a11"]);
    expect(tree.descendants("a").map((f) => f.id)).toEqual(["a1", "a11"]);
    expect(tree.contains("a", "a11")).toBe(true);
    expect(tree.contains("a11", "a")).toBe(false);
    expect(tree.flatten().map((x) => [x.folder.id, x.depth])).toEqual([
      ["a", 0],
      ["a1", 1],
      ["a11", 2],
      ["b", 0],
    ]);
  });

  it("a missing parent, a loop, or a missing folder shows at the top level", () => {
    const tree = buildFolderTree(
      [folder("orphan", "gone"), folder("x", "y"), folder("y", "x"), folder("z", "x")],
      [task("t", "gone", "a0")],
    );
    expect(tree.folders(null).map((f) => f.id).sort()).toEqual(["orphan", "x", "y"]);
    expect(tree.folders("x").map((f) => f.id)).toEqual(["z"]);
    expect(tree.tasks(null).map((t) => t.id)).toEqual(["t"]);
  });

  it("lists the recent area first (tasks and folders mixed), then folders, then tasks", () => {
    const tree = buildFolderTree(
      [folder("f1", null, "a0"), folder("f2", null, "a1"), folder("newF", null, "Zz", true)],
      [task("t1", null, "a0"), task("newT", null, "Zy", true), task("moved", null, "a5", true)],
    );
    expect(tree.items(null).map((e) => [e.id, e.top])).toEqual([
      ["newT", true],
      ["newF", true],
      ["moved", true],
      ["f1", false],
      ["f2", false],
      ["t1", false],
    ]);
    expect(tree.folders(null).map((f) => f.id)).toEqual(["newF", "f1", "f2"]);
    expect(tree.tasks(null).map((t) => t.id)).toEqual(["newT", "moved", "t1"]);
  });

  it("a task with no TASKS-tab order yet (older version) uses its priority rank", () => {
    const tree = buildFolderTree([], [task("old", null, null), task("new", null, "a3")], [{ taskId: "old", rank: "a5" }]);
    expect(tree.tasks(null).map((t) => t.id)).toEqual(["new", "old"]);
  });
});

function setup() {
  const store = new MemoryStore();
  const sync = { requestSync: () => undefined };
  return {
    store,
    tasks: new TaskActions({ store, sync }),
    folders: new FolderActions({ store, sync }),
    priority: new PriorityActions({ store, sync }),
    tree: async () => buildFolderTree(await store.listFolders(), await store.listTasks(), await store.listPlacements()),
    ops: async () => (await store.listOutbox()).map((c) => c.op),
  };
}

describe("FolderActions", () => {
  it("new folders and tasks go to the very TOP of their folder, above older folders; priority is untouched", async () => {
    const app = setup();
    const work = await app.folders.create("Work");
    await app.folders.create("Home");
    await app.tasks.create({ title: "a", folderId: work });
    await app.tasks.create({ title: "b", folderId: work });
    await app.tasks.create({ title: "loose" });
    const tree = await app.tree();
    const names = (p: string | null) => tree.items(p).map((e) => (e.kind === "folder" ? e.folder.name : e.task.title));
    expect(names(null)).toEqual(["loose", "Home", "Work"]);
    expect(names(work)).toEqual(["b", "a"]);
    expect(tree.items(null).every((e) => e.top)).toBe(true);
    // New tasks still go on top of the priority list, folder or not.
    expect(priorityOrder(await app.store.listTasks(), await app.store.listPlacements()).map((t) => t.title)).toEqual([
      "loose",
      "b",
      "a",
    ]);
  });

  it("names are required and unique among siblings (ignoring case); same name elsewhere is fine", async () => {
    const app = setup();
    const work = await app.folders.create("  Work ");
    expect((await app.tree()).get(work)!.name).toBe("Work");
    await expect(app.folders.create("work")).rejects.toThrow('already a folder called "work"');
    await expect(app.folders.create("   ")).rejects.toThrow("required");
    await app.folders.create("Work", work); // inside Work: a different parent
    const home = await app.folders.create("Home");
    await expect(app.folders.rename(home, "WORK")).rejects.toThrow("already");
    await app.folders.rename(home, "House");
    await app.folders.rename(work, "Work"); // unchanged: nothing recorded
    expect(await app.ops()).toEqual(["createFolder", "createFolder", "createFolder", "renameFolder"]);
  });

  it("moves folders and tasks, in order or into another folder; never into itself", async () => {
    const app = setup();
    const a = await app.folders.create("A");
    const b = await app.folders.create("B");
    const c = await app.folders.create("C");
    expect((await app.tree()).folders(null).map((f) => f.name)).toEqual(["C", "B", "A"]);
    await app.folders.moveFolder(c, null, { top: true, index: 2 });
    expect((await app.tree()).folders(null).map((f) => f.name)).toEqual(["B", "A", "C"]);
    await app.folders.moveFolder(b, a);
    await expect(app.folders.moveFolder(a, b)).rejects.toThrow("inside itself");
    await expect(app.folders.moveFolder(a, a)).rejects.toThrow("inside itself");
    await app.folders.create("B"); // a second "B" at the top level
    const top = (await app.tree()).folders(null).find((f) => f.name === "B")!.id;
    await expect(app.folders.moveFolder(top, a)).rejects.toThrow("already");

    const t1 = await app.tasks.create({ title: "t1" });
    const t2 = await app.tasks.create({ title: "t2" });
    await app.folders.moveTask(t2.id, null, { top: true, index: 1 });
    expect((await app.tree()).tasks(null).map((t) => t.title)).toEqual(["t1", "t2"]);
    await app.folders.moveTask(t1.id, b);
    const tree = await app.tree();
    expect(tree.tasks(b).map((t) => t.title)).toEqual(["t1"]);
    expect(tree.taskCount(a)).toBe(1);
  });

  it("moved-in items land at the very top; dragged out of the recent area they join their block, and can go back", async () => {
    const app = setup();
    const store = app.store;
    // Today's layout: two older folders and an older task, none recent.
    await store.write(async (tx) => {
      await tx.putFolder(folder(uuidv7(), null, "a0"));
      await tx.putTask(task(uuidv7(), null, "a0"));
    });
    const [oldF] = await store.listFolders();
    const [oldT] = await store.listTasks();
    const box = await app.folders.create("Box");
    const fresh = await app.tasks.create({ title: "fresh" });
    const order = async (p: string | null) => (await app.tree()).items(p).map((e) => [e.id, e.top]);
    expect(await order(null)).toEqual([
      [fresh.id, true],
      [box, true],
      [oldF!.id, false],
      [oldT!.id, false],
    ]);

    // Into Box: the very top of Box.
    await app.folders.moveTask(oldT!.id, box);
    await app.folders.moveFolder(oldF!.id, box);
    expect(await order(box)).toEqual([
      [oldF!.id, true],
      [oldT!.id, true],
    ]);

    // Dragged out of the recent area into the tasks block, then back up.
    await app.folders.moveTask(oldT!.id, box, { top: false, index: 0 });
    expect(await order(box)).toEqual([
      [oldF!.id, true],
      [oldT!.id, false],
    ]);
    await app.folders.moveTask(oldT!.id, box, { top: true, index: 0 });
    expect(await order(box)).toEqual([
      [oldT!.id, true],
      [oldF!.id, true],
    ]);
    const last = (await app.store.listOutbox()).at(-1)!;
    expect(last).toMatchObject({ op: "setTaskFolder", folderTop: true });
  });

  it("removing a folder deletes its sub-folders and every task in them (they leave priority too)", async () => {
    const app = setup();
    const a = await app.folders.create("A");
    const b = await app.folders.create("B", a);
    const keep = await app.folders.create("Keep");
    await app.tasks.create({ title: "in a", folderId: a });
    await app.tasks.create({ title: "in b", folderId: b });
    await app.tasks.create({ title: "kept", folderId: keep });
    await app.folders.remove(a);
    const tree = await app.tree();
    expect(tree.flatten().map((x) => x.folder.name)).toEqual(["Keep"]);
    expect((await app.store.listTasks()).map((t) => t.title)).toEqual(["kept"]);
    expect((await app.store.listPlacements()).length).toBe(1);
    expect((await app.ops()).slice(-4)).toEqual(["deleteTask", "deleteTask", "deleteFolder", "deleteFolder"]);
  });

  it("a stale local move that would make a loop is refused locally too", async () => {
    const store = new MemoryStore();
    await store.write(async (tx) => {
      await tx.putFolder({ id: "a", name: "a", parentId: null, rank: "a0" });
      await tx.putFolder({ id: "b", name: "b", parentId: "a", rank: "a0" });
      await applyChangeLocally(tx, { changeId: uuidv7(), op: "moveFolder", folderId: "a", parentId: "b", rank: "a0" });
    });
    expect((await store.listFolders()).find((f) => f.id === "a")!.parentId).toBeNull();
  });
});
