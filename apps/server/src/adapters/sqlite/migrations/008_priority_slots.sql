-- A card dragged out of its ranked folder's group keeps its own rank
-- (placements.own_rank = 1) until it is dragged back among them.
ALTER TABLE placements ADD COLUMN own_rank INTEGER CHECK (own_rank IS NULL OR own_rank IN (0, 1));

-- SCHEDULED priority lists: from start_ms to end_ms the list is in force.
-- list / restore are JSON (PlanList), written whole by the devices.
CREATE TABLE priority_slots (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id       TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms   INTEGER NOT NULL,
  list     TEXT NOT NULL,
  restore  TEXT,
  restored INTEGER CHECK (restored IS NULL OR restored IN (0, 1)),
  PRIMARY KEY (user_id, id)
) STRICT;
CREATE INDEX priority_slots_user_start ON priority_slots(user_id, start_ms);

-- change_log learns 'priority_slots'. SQLite cannot alter a CHECK, so the
-- table is rebuilt, keeping every row AND the AUTOINCREMENT high-water mark
-- (devices' cursors must stay valid). Same recipe as 003 and 005.
CREATE TABLE change_log_new (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  table_name TEXT NOT NULL CHECK (table_name IN ('tasks', 'placements', 'log_entries', 'priority_history', 'timer', 'folders', 'priority_slots')),
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
