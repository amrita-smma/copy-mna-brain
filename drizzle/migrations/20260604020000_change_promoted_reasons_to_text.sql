-- Migration: Convert companies.promoted_reasons from text[] to text.
-- Created: 2026-06-04
--
-- Direction change after review feedback: promoted_reasons should be a
-- single free-text block (like dropped_reason), not a typed array. Multiple
-- reasons within a single promotion are expressed as a markdown list inside
-- the text. Multiple promotion events accumulate by appending the new block
-- to the existing content with a blank-line separator (handled in the
-- service layer).
--
-- Pre-existing array entries are stitched back into a markdown list,
-- prefixing each element with "- " and joining by newlines. NULL/empty
-- arrays map to NULL.

ALTER TABLE companies
  ADD COLUMN promoted_reasons_new text;

UPDATE companies
SET promoted_reasons_new = (
  SELECT string_agg('- ' || elem, E'\n')
  FROM unnest(promoted_reasons) AS elem
)
WHERE array_length(promoted_reasons, 1) > 0;

ALTER TABLE companies DROP COLUMN promoted_reasons;

ALTER TABLE companies RENAME COLUMN promoted_reasons_new TO promoted_reasons;

COMMENT ON COLUMN companies.promoted_reasons IS 'Free-text (markdown) block of promotion reasons. Each promotion appends its block separated by a blank line. NULL when never promoted with a reason.';
