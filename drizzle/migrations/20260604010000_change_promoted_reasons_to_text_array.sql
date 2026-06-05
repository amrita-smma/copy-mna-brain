-- Migration: Convert companies.promoted_reasons from jsonb to text[].
-- Created: 2026-06-04
--
-- We initially typed promoted_reasons as jsonb (matching human_decisions on
-- ai_workforce_queue), but the column only ever holds a flat list of strings
-- — no nested structure. Postgres-native text[] is the right shape for that:
-- typed at the DB level, simpler query syntax (`= ANY(...)`), and matches
-- the existing `files.tags` pattern in this codebase.
--
-- Postgres doesn't allow subqueries inside ALTER COLUMN ... USING (the
-- jsonb -> text[] conversion needs one), so we do it in four steps: add a
-- new column, backfill via UPDATE, drop the old column, rename the new one.
-- Assumes idx 49 already normalized any object entries to strings.

ALTER TABLE companies
  ADD COLUMN promoted_reasons_new text[] NOT NULL DEFAULT ARRAY[]::text[];

UPDATE companies
SET promoted_reasons_new = COALESCE(
  (SELECT array_agg(value) FROM jsonb_array_elements_text(promoted_reasons) AS value),
  ARRAY[]::text[]
)
WHERE jsonb_array_length(promoted_reasons) > 0;

ALTER TABLE companies DROP COLUMN promoted_reasons;

ALTER TABLE companies RENAME COLUMN promoted_reasons_new TO promoted_reasons;

COMMENT ON COLUMN companies.promoted_reasons IS 'Append-only array of free-text promotion reasons. Mirrors dropped_reason but supports multiple entries per company.';
