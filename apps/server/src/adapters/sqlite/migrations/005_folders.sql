-- FOLDERS in the TASKS tab. They group tasks for browsing only: no other
-- screen reads them.

CREATE TABLE folders (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id        TEXT NOT NULL,
  name      TEXT NOT NULL,
  parent_id TEXT,                          -- NULL = top level; a missing parent also shows at the top
  rank      TEXT NOT NULL,                 -- manual order among siblings
  PRIMARY KEY (user_id, id)
) STRICT;

-- Where a task sits in the TASKS tab (NULL = top level) and its manual order there.
ALTER TABLE tasks ADD COLUMN folder_id TEXT;
ALTER TABLE tasks ADD COLUMN folder_rank TEXT;

-- Existing tasks keep the order the TASKS tab showed them in: their priority rank.
UPDATE tasks SET folder_rank = (
  SELECT p.rank FROM placements p WHERE p.user_id = tasks.user_id AND p.task_id = tasks.id
);

-- change_log learns 'folders'. SQLite cannot alter a CHECK, so the table is
-- rebuilt, keeping every row AND the AUTOINCREMENT high-water mark (devices'
-- cursors must stay valid). Same recipe as 003.
CREATE TABLE change_log_new (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  table_name TEXT NOT NULL CHECK (table_name IN ('tasks', 'placements', 'log_entries', 'priority_history', 'timer', 'folders')),
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

-- Devices pull the tasks again, so they learn their TASKS-tab order.
INSERT INTO change_log (user_id, table_name, row_id, op, created_at)
  SELECT user_id, 'tasks', id, 'upsert', CAST(unixepoch('subsec') * 1000 AS INTEGER)
  FROM tasks WHERE folder_rank IS NOT NULL ORDER BY user_id, id;
