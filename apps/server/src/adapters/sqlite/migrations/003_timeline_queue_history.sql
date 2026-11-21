-- One shared TIMER, logs placed on the clock, the WAITING QUEUE and the
-- PRIORITY HISTORY.

-- Start of the one TIMER all devices share (epoch ms). The latest start wins.
ALTER TABLE users ADD COLUMN timer_start INTEGER;

-- When a task was dropped into the waiting queue (epoch ms); NULL = not queued.
ALTER TABLE placements ADD COLUMN queued_at INTEGER;

-- A log covers [start_ms, start_ms + seconds·1000). NULL for older logs.
ALTER TABLE log_entries ADD COLUMN start_ms INTEGER;
ALTER TABLE log_entries ADD COLUMN source TEXT CHECK (source IS NULL OR source IN ('timer', 'manual'));
CREATE INDEX log_entries_user_start ON log_entries(user_id, start_ms);

-- The scoring order (JSON array of titles, best first) from `at` on.
CREATE TABLE priority_history (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id      TEXT NOT NULL,
  at      INTEGER NOT NULL,
  titles  TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
) STRICT;
CREATE INDEX priority_history_user_at ON priority_history(user_id, at);

-- change_log learns two more names. SQLite cannot alter a CHECK, so the
-- table is rebuilt, keeping every row AND the AUTOINCREMENT high-water mark
-- (devices' cursors must stay valid).
CREATE TABLE change_log_new (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  table_name TEXT NOT NULL CHECK (table_name IN ('tasks', 'placements', 'log_entries', 'priority_history', 'timer')),
  row_id     TEXT NOT NULL,
  op         TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
  created_at INTEGER NOT NULL
) STRICT;
INSERT INTO change_log_new (seq, user_id, table_name, row_id, op, created_at)
  SELECT seq, user_id, table_name, row_id, op, created_at FROM change_log;
DELETE FROM sqlite_sequence WHERE name = 'change_log_new';
INSERT INTO sqlite_sequence (name, seq) SELECT 'change_log_new', seq FROM sqlite_sequence WHERE name = 'change_log';
DROP TABLE change_log;
ALTER TABLE change_log_new RENAME TO change_log;
CREATE INDEX change_log_user_seq ON change_log(user_id, seq);
CREATE INDEX change_log_row ON change_log(user_id, table_name, row_id, seq);
CREATE INDEX change_log_created ON change_log(created_at);
