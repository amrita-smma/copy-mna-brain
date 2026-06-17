-- Support permanent system routines (e.g. the market-scanning routine).
--
-- `is_system` marks routines owned by the platform rather than a user — these
-- are guarded against edit/archive via the API. `created_by` becomes nullable
-- so a system routine can exist without a human owner.
--
-- The market-scanning routine itself is NOT seeded here: its schedule (cadence)
-- and the number of companies per scan are derived from the active investment
-- thesis and kept in sync by MarketScanningRoutineService whenever the thesis
-- is saved. Hardcoding those values in a migration would let them drift from
-- the thesis.

ALTER TABLE routines
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

ALTER TABLE routines
  ALTER COLUMN created_by DROP NOT NULL;
