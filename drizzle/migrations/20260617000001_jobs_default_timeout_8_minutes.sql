-- Raise the default job timeout from 240s (4 min) to 480s (8 min).
-- Non-destructive: only changes the column default for future inserts that
-- omit timeout_seconds. Existing rows are untouched.
ALTER TABLE jobs ALTER COLUMN timeout_seconds SET DEFAULT 480;
