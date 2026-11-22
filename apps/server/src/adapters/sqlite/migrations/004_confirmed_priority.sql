-- PRIORITY HISTORY snapshots are now taken only when the user presses the
-- confirm icon. 1 = confirmed; NULL = a legacy snapshot taken automatically
-- by an older version (it only scores the time before the first confirmed one).
ALTER TABLE priority_history ADD COLUMN confirmed INTEGER CHECK (confirmed IS NULL OR confirmed IN (0, 1));
