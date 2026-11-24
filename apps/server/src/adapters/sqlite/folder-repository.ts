import type { DatabaseSync } from "node:sqlite";
import type { Folder } from "@pm/shared";
import type { FolderRepository } from "../../ports/repositories.ts";
import { selectIn, type Row } from "./sql.ts";

const toFolder = (r: Row): Folder => ({
  id: r.id as string,
  name: r.name as string,
  parentId: (r.parent_id as string | null) ?? null,
  rank: r.rank as string,
  top: r.top === 1,
});

export class SqliteFolderRepository implements FolderRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async get(userId: string, id: string) {
    const r = this.db.prepare("SELECT * FROM folders WHERE user_id = ? AND id = ?").get(userId, id) as Row | undefined;
    return r ? toFolder(r) : null;
  }

  async getMany(userId: string, ids: readonly string[]) {
    return selectIn(this.db, (p) => `SELECT * FROM folders WHERE user_id = ? AND id IN (${p})`, [userId], ids).map(toFolder);
  }

  async listAll(userId: string) {
    return (this.db.prepare("SELECT * FROM folders WHERE user_id = ? ORDER BY id").all(userId) as Row[]).map(toFolder);
  }

  async insert(userId: string, f: Folder) {
    this.db
      .prepare("INSERT INTO folders (user_id, id, name, parent_id, rank, top) VALUES (?, ?, ?, ?, ?, ?)")
      .run(userId, f.id, f.name, f.parentId, f.rank, f.top ? 1 : 0);
  }

  async rename(userId: string, id: string, name: string) {
    this.db.prepare("UPDATE folders SET name = ? WHERE user_id = ? AND id = ?").run(name, userId, id);
  }

  async move(userId: string, id: string, parentId: string | null, rank: string, top: boolean) {
    this.db
      .prepare("UPDATE folders SET parent_id = ?, rank = ?, top = ? WHERE user_id = ? AND id = ?")
      .run(parentId, rank, top ? 1 : 0, userId, id);
  }

  async delete(userId: string, id: string) {
    this.db.prepare("DELETE FROM folders WHERE user_id = ? AND id = ?").run(userId, id);
  }
}
