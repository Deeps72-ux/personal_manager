#!/usr/bin/env node
/**
 * Consistent online backup of the SQLite database.
 *
 *   - VACUUM INTO makes a clean, self-contained copy while the server keeps
 *     running (it reads one consistent snapshot; WAL is folded in).
 *   - The copy is integrity-checked before it is kept.
 *   - Keeps the newest BACKUP_KEEP files (default 30).
 *   - Optionally mirrors each backup to BACKUP_MIRROR_DIR (e.g. a folder in
 *     iCloud Drive or an external disk) so a dead Mac disk loses nothing.
 *
 * Env: DATA_DIR (required), BACKUP_DIR (required), BACKUP_KEEP, BACKUP_MIRROR_DIR
 * No dependencies: only Node built-ins.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = process.env.DATA_DIR;
const BACKUP_DIR = process.env.BACKUP_DIR;
const KEEP = Number(process.env.BACKUP_KEEP ?? 30);
const MIRROR = process.env.BACKUP_MIRROR_DIR || null;

if (!DATA_DIR || !BACKUP_DIR) {
  console.error("DATA_DIR and BACKUP_DIR are required");
  process.exit(2);
}
const source = join(DATA_DIR, "personal-manager.db");
if (!existsSync(source)) {
  console.log(`nothing to back up yet (${source} does not exist)`);
  process.exit(0);
}

const now = process.env.BACKUP_NOW ? new Date(process.env.BACKUP_NOW) : new Date(); // override: tests only
const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15); // 20261105-031500
const name = `personal-manager-${stamp}.db`;
mkdirSync(BACKUP_DIR, { recursive: true });
const tmp = join(BACKUP_DIR, `.${name}.partial`);
const final = join(BACKUP_DIR, name);

const db = new DatabaseSync(source);
try {
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
} finally {
  db.close();
}

const copy = new DatabaseSync(tmp, { readOnly: true });
let summary;
try {
  const check = copy.prepare("PRAGMA integrity_check").get();
  if (check?.integrity_check !== "ok") throw new Error(`integrity check failed: ${JSON.stringify(check)}`);
  const count = (t) => Number(copy.prepare(`SELECT count(*) AS n FROM ${t}`).get().n);
  summary = { users: count("users"), tasks: count("tasks"), logEntries: count("log_entries") };
} catch (err) {
  copy.close();
  rmSync(tmp, { force: true });
  throw err;
}
copy.close();
renameSync(tmp, final); // only complete, verified files ever get the final name

const rotate = (dir) => {
  const files = readdirSync(dir)
    .filter((f) => /^personal-manager-\d{8}-\d{6}\.db$/.test(f))
    .sort()
    .reverse();
  for (const old of files.slice(KEEP)) rmSync(join(dir, old));
  return Math.min(files.length, KEEP);
};
const kept = rotate(BACKUP_DIR);

let mirrored = "";
if (MIRROR) {
  try {
    mkdirSync(MIRROR, { recursive: true });
    copyFileSync(final, join(MIRROR, name));
    rotate(MIRROR);
    mirrored = ` · mirrored to ${MIRROR}`;
  } catch (err) {
    // The local backup succeeded; report the mirror problem but don't fail.
    console.error(`mirror failed: ${err.message}`);
  }
}

const kb = Math.round(statSync(final).size / 1024);
console.log(
  `${new Date().toISOString()} backup ok: ${final} (${kb} KB; ${summary.users} users, ${summary.tasks} tasks, ` +
    `${summary.logEntries} log entries; keeping ${kept})${mirrored}`,
);
