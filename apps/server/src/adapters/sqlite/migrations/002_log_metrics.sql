-- FOCUS and DEVIATION (percent, 0-100) of a TIMER log, computed on the
-- device when ✓ is pressed. NULL for manual logs and rows from before this.
ALTER TABLE log_entries ADD COLUMN focus REAL CHECK (focus IS NULL OR focus BETWEEN 0 AND 100);
ALTER TABLE log_entries ADD COLUMN deviation REAL CHECK (deviation IS NULL OR deviation BETWEEN 0 AND 100);
