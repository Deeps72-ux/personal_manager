-- Past activities the user removed from the suggestion chips (logs untouched).
CREATE TABLE hidden_activities (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id        TEXT NOT NULL,
  name      TEXT NOT NULL,
  hidden_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
) STRICT;

-- change_log learns 'hidden_activities' (table rebuilt; same recipe as 008).
CREATE TABLE change_log_new (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  table_name TEXT NOT NULL CHECK (table_name IN ('tasks', 'placements', 'log_entries', 'priority_history', 'timer', 'folders', 'priority_slots', 'hidden_activities')),
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
