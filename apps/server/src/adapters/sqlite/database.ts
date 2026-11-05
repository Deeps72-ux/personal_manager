import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

/** Open (or create) the database file, set safe pragmas, apply migrations. */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;      -- readers never block the writer; crash-safe
    PRAGMA synchronous = NORMAL;    -- durable with WAL, much faster than FULL
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db);
  return db;
}

/**
 * Applies `NNN_name.sql` files whose number is above PRAGMA user_version,
 * each in its own transaction. Adding a migration = adding a file.
 */
export function migrate(db: DatabaseSync): void {
  const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();

  for (const file of files) {
    const version = Number.parseInt(file, 10);
    if (version <= current) continue;
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
    }
  }
}
