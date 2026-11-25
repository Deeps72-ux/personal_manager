-- Ranks the user types in PRIORITY: on one card (placements.user_rank) or on
-- a folder, given to every task inside it (folders.priority). Confirmed
-- snapshots keep each title's rank (priority_history.ranks, a JSON array
-- parallel to titles). NULL everywhere = rank by position, as before.
ALTER TABLE placements ADD COLUMN user_rank INTEGER CHECK (user_rank IS NULL OR user_rank >= 1);
ALTER TABLE folders ADD COLUMN priority INTEGER CHECK (priority IS NULL OR priority >= 1);
ALTER TABLE priority_history ADD COLUMN ranks TEXT;
