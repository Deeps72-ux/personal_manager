/**
 * TASKS-tab FOLDERS on the server: the five ops, the "folder inside itself"
 * refusal, and the upgrade of a database that already has tasks.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { uuidv7, type Folder } from "@pm/shared";
import { migrate } from "../src/adapters/sqlite/database.ts";
import { ch, newUser, task, testContainer } from "./helpers.ts";

const folder = (name: string, extra: Partial<Folder> = {}): Folder => ({ id: uuidv7(), name, parentId: null, rank: "a0", top: false, ...extra });

describe("folder ops", () => {
  it("create (idempotent), rename, move, delete reach other devices", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const work = folder("Work");
    const home = folder("Home", { rank: "a1" });
    const create = ch({ op: "createFolder", folder: work });
    await c.useCases.push.execute(userId, [create, create, ch({ op: "createFolder", folder: home })]);
    const start = (await c.useCases.pull.execute(userId, 0)).cursor;
    expect((await c.useCases.pull.execute(userId, 0)).upserts.folders).toEqual([work, home].sort((a, b) => (a.id < b.id ? -1 : 1)));

    await c.useCases.push.execute(userId, [
      ch({ op: "renameFolder", folderId: work.id, name: "Job" }),
      ch({ op: "moveFolder", folderId: work.id, parentId: home.id, rank: "a5" }),
    ]);
    const inc = await c.useCases.pull.execute(userId, start);
    expect(inc.upserts.folders).toEqual([{ ...work, name: "Job", parentId: home.id, rank: "a5" }]);

    const del = await c.useCases.push.execute(userId, [ch({ op: "deleteFolder", folderId: work.id })]);
    expect(del.results[0]!.status).toBe("applied");
    const after = await c.useCases.pull.execute(userId, inc.cursor);
    expect(after.deletes.folders).toEqual([work.id]);
    // Later edits of a deleted folder are ignored; recreating it is refused.
    const late = await c.useCases.push.execute(userId, [
      ch({ op: "renameFolder", folderId: work.id, name: "x" }),
      ch({ op: "createFolder", folder: work }),
      ch({ op: "deleteFolder", folderId: work.id }),
    ]);
    expect(late.results.map((r) => (r.status === "ignored" ? r.reason : r.status))).toEqual(["deleted", "deleted", "notFound"]);
  });

  it("refuses to put a folder inside itself and re-sends it so the device undoes it", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const a = folder("A");
    const b = folder("B", { parentId: a.id });
    await c.useCases.push.execute(userId, [ch({ op: "createFolder", folder: a }), ch({ op: "createFolder", folder: b })]);
    const cursor = (await c.useCases.pull.execute(userId, 0)).cursor;
    // Another device, apart, moved A into B (its sub-folder here).
    const r = await c.useCases.push.execute(userId, [
      ch({ op: "moveFolder", folderId: a.id, parentId: b.id, rank: "a0" }),
      ch({ op: "moveFolder", folderId: a.id, parentId: a.id, rank: "a0" }),
    ]);
    expect(r.results.map((x) => (x.status === "ignored" ? x.reason : x.status))).toEqual(["invalid", "invalid"]);
    const inc = await c.useCases.pull.execute(userId, cursor);
    expect(inc.upserts.folders).toEqual([a]); // unchanged, sent again
  });

  it("setTaskFolder files a task; creating a task keeps its folder; other users can't see folders", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const other = await newUser(c);
    const work = folder("Work");
    const t = task("Gym", { folderId: work.id, folderRank: "a0" });
    const u = task("Read");
    await c.useCases.push.execute(userId, [
      ch({ op: "createFolder", folder: work }),
      ch({ op: "createTask", task: t, rank: "a0" }),
      ch({ op: "createTask", task: u, rank: "a1" }),
      ch({ op: "setTaskFolder", taskId: u.id, folderId: work.id, folderRank: "a1" }),
    ]);
    const snap = await c.useCases.pull.execute(userId, 0);
    expect(snap.upserts.tasks.find((x) => x.id === t.id)).toEqual(t);
    expect(snap.upserts.tasks.find((x) => x.id === u.id)).toMatchObject({ folderId: work.id, folderRank: "a1" });
    expect((await c.useCases.pull.execute(other.userId, 0)).upserts.folders).toEqual([]);
    const gone = await c.useCases.push.execute(userId, [
      ch({ op: "deleteTask", taskId: u.id }),
      ch({ op: "setTaskFolder", taskId: u.id, folderId: null, folderRank: "a0" }),
    ]);
    expect(gone.results[1]).toMatchObject({ status: "ignored", reason: "deleted" });
  });

  it("keeps the recent-area flag of folders and tasks; an op from an older device leaves it off", async () => {
    const c = testContainer();
    const { userId } = await newUser(c);
    const box = folder("Box", { top: true });
    const inner = folder("Inner");
    const t = task("Gym", { folderId: box.id, folderRank: "a0", folderTop: true });
    await c.useCases.push.execute(userId, [
      ch({ op: "createFolder", folder: box }),
      ch({ op: "createFolder", folder: inner }),
      ch({ op: "createTask", task: t, rank: "a0" }),
      ch({ op: "moveFolder", folderId: inner.id, parentId: box.id, rank: "Zz", top: true }),
    ]);
    let snap = await c.useCases.pull.execute(userId, 0);
    expect(snap.upserts.folders.find((f) => f.id === box.id)).toEqual(box);
    expect(snap.upserts.folders.find((f) => f.id === inner.id)).toMatchObject({ parentId: box.id, top: true });
    expect(snap.upserts.tasks.find((x) => x.id === t.id)).toEqual(t);

    await c.useCases.push.execute(userId, [
      ch({ op: "setTaskFolder", taskId: t.id, folderId: box.id, folderRank: "a1" }),
      ch({ op: "moveFolder", folderId: inner.id, parentId: box.id, rank: "a0" }),
    ]);
    snap = await c.useCases.pull.execute(userId, 0);
    expect(snap.upserts.tasks.find((x) => x.id === t.id)).toMatchObject({ folderRank: "a1", folderTop: false });
    expect(snap.upserts.folders.find((f) => f.id === inner.id)).toMatchObject({ top: false });
  });
});

describe("migration 005", () => {
  it("keeps existing tasks in their priority order and makes devices pull them again", () => {
    const db = new DatabaseSync(":memory:");
    // Bring a database up to version 4 by hand-running migrate, then roll back the folders step.
    migrate(db);
    db.exec("DROP TABLE folders");
    db.exec("DROP TABLE priority_slots");
    db.exec("ALTER TABLE placements DROP COLUMN own_rank");
    db.exec("ALTER TABLE placements DROP COLUMN user_rank");
    db.exec("ALTER TABLE priority_history DROP COLUMN ranks");
    db.exec("ALTER TABLE tasks DROP COLUMN folder_top");
    db.exec("ALTER TABLE tasks DROP COLUMN folder_rank");
    db.exec("ALTER TABLE tasks DROP COLUMN folder_id");
    db.exec("PRAGMA user_version = 4");
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'me', 'x')").run();
    db.prepare("INSERT INTO tasks (user_id, id, title) VALUES ('u1', 't1', 'Gym')").run();
    db.prepare("INSERT INTO placements (user_id, task_id, rank) VALUES ('u1', 't1', 'a7')").run();
    db.prepare("INSERT INTO change_log (user_id, table_name, row_id, op, created_at) VALUES ('u1', 'tasks', 't1', 'upsert', 1)").run();
    const before = Number((db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'change_log'").get() as { seq: number }).seq);

    migrate(db);
    expect(db.prepare("SELECT folder_id, folder_rank FROM tasks").get()).toEqual({ folder_id: null, folder_rank: "a7" });
    const rows = db.prepare("SELECT seq, table_name, row_id FROM change_log ORDER BY seq").all();
    expect(rows).toEqual([
      { seq: before, table_name: "tasks", row_id: "t1" },
      { seq: before + 1, table_name: "tasks", row_id: "t1" },
    ]);
    db.close();
  });
});
