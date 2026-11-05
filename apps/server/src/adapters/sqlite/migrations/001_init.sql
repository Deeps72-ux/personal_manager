-- Initial schema. Plain SQL: readable, and runnable from any language.
-- STRICT tables make SQLite enforce column types.
-- Isolation: every user-data table has (user_id, id) as its PRIMARY KEY.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  purged_before TEXT                       -- purge guard: logs with day < this are refused
) STRICT;

-- Login sessions. Only a SHA-256 hash of the token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL              -- unix ms
) STRICT;
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE tasks (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  due_date    TEXT,
  PRIMARY KEY (user_id, id)
) STRICT;

CREATE TABLE placements (
  user_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  rank    TEXT NOT NULL,
  PRIMARY KEY (user_id, task_id),
  FOREIGN KEY (user_id, task_id) REFERENCES tasks(user_id, id) ON DELETE CASCADE
) STRICT;

-- Independent of tasks on purpose: holds a copy of the title, no task id.
CREATE TABLE log_entries (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  day        TEXT NOT NULL,
  seconds    INTEGER NOT NULL CHECK (seconds BETWEEN 1 AND 86400),
  task_title TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
) STRICT;
CREATE INDEX log_entries_user_day ON log_entries(user_id, day);

-- Server-only sync history. No content, only "row X changed / was deleted".
-- created_at exists solely for the 30-day cleanup.
CREATE TABLE change_log (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  table_name TEXT NOT NULL CHECK (table_name IN ('tasks', 'placements', 'log_entries')),
  row_id     TEXT NOT NULL,
  op         TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX change_log_user_seq ON change_log(user_id, seq);
CREATE INDEX change_log_row ON change_log(user_id, table_name, row_id, seq);
CREATE INDEX change_log_created ON change_log(created_at);
