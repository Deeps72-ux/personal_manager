/**
 * The backup job (deploy/backup.mjs) run as a real process against a real
 * database file.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/adapters/sqlite/database.ts";

const SCRIPT = resolve(import.meta.dirname, "../../../deploy/backup.mjs");

function seeded() {
  const root = mkdtempSync(join(tmpdir(), "pm-backup-"));
  const data = join(root, "data");
  const db = openDatabase(join(data, "personal-manager.db"));
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'deepan', 'x')").run();
  db.prepare("INSERT INTO tasks (user_id, id, title) VALUES ('u1', 't1', 'Gym')").run();
  db.prepare("INSERT INTO log_entries (user_id, id, day, seconds, task_title) VALUES ('u1', 'l1', '2026-11-05', 27, 'Gym')").run();
  return { root, data, db }; // db stays OPEN, like the running server
}

const run = (env: Record<string, string>) =>
  execFileSync(process.execPath, [SCRIPT], { env: { ...process.env, ...env }, encoding: "utf8" });

describe("backup.mjs", () => {
  it("makes a verified copy while the database is open, rotates, mirrors", () => {
    const { root, data, db } = seeded();
    const backups = join(root, "backups");
    const mirror = join(root, "mirror");
    const env = { DATA_DIR: data, BACKUP_DIR: backups, BACKUP_KEEP: "2", BACKUP_MIRROR_DIR: mirror };

    const out = run({ ...env, BACKUP_NOW: "2026-11-01T03:00:00Z" });
    expect(out).toContain("backup ok");
    expect(out).toContain("1 users, 1 tasks, 1 log entries");

    db.prepare("INSERT INTO tasks (user_id, id, title) VALUES ('u1', 't2', 'Read')").run(); // server keeps writing
    run({ ...env, BACKUP_NOW: "2026-11-02T03:00:00Z" });
    run({ ...env, BACKUP_NOW: "2026-11-03T03:00:00Z" });

    const files = readdirSync(backups).sort();
    expect(files).toEqual(["personal-manager-20261102-030000.db", "personal-manager-20261103-030000.db"]);
    expect(readdirSync(mirror).sort()).toEqual(files);

    // The newest backup is a complete, usable database with the latest write.
    const copy = new DatabaseSync(join(backups, files[1]!), { readOnly: true });
    expect(copy.prepare("SELECT title FROM tasks ORDER BY id").all()).toEqual([{ title: "Gym" }, { title: "Read" }]);
    copy.close();
    db.close();
  });

  it("does nothing (successfully) before the first database exists", () => {
    const root = mkdtempSync(join(tmpdir(), "pm-backup-empty-"));
    expect(run({ DATA_DIR: join(root, "data"), BACKUP_DIR: join(root, "b") })).toContain("nothing to back up yet");
  });

  it("refuses to run without its settings", () => {
    expect(() => execFileSync(process.execPath, [SCRIPT], { env: {}, stdio: "pipe" })).toThrow();
  });
});
