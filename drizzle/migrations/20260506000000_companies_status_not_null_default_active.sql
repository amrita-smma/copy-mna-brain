-- Migration: Make companies.status NOT NULL with default 'active'.
-- Created: 2026-05-06
--
-- Rationale: three valid states (NULL / 'active' / 'dropped') leaked into UIs
-- as "—" / "Pending" / etc. NULL was always treated semantically as 'active'
-- by existing code (e.g. excludeDropped uses OR(IS NULL, != 'dropped')), and
-- the file/prospectus and market-screening insert paths leave it unset.
-- Collapsing to two states removes the ambiguity and lets the column default
-- backfill missing values for those callers.

-- 1. Backfill any existing NULLs to 'active'.
UPDATE companies SET status = 'active' WHERE status IS NULL;

-- 2. Lock the column down with default + NOT NULL.
ALTER TABLE companies
  ALTER COLUMN status SET DEFAULT 'active',
  ALTER COLUMN status SET NOT NULL;

COMMENT ON COLUMN companies.status IS 'Company lifecycle status: active or dropped. Defaults to active for new rows.';
