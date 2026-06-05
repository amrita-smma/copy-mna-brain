-- Migration: Normalize companies.promoted_reasons entries to plain strings.
-- Created: 2026-06-04
--
-- Earlier iteration stored each entry as a structured object
-- ({ reason, from_stage, to_stage, promoted_at }). We've since simplified to
-- a flat array of reason strings. Any pre-existing rows with object entries
-- are flattened to their `reason` field.

UPDATE companies
SET promoted_reasons = (
  SELECT COALESCE(jsonb_agg(
    CASE
      WHEN jsonb_typeof(elem) = 'object' THEN elem->'reason'
      ELSE elem
    END
  ), '[]'::jsonb)
  FROM jsonb_array_elements(promoted_reasons) AS elem
)
WHERE jsonb_array_length(promoted_reasons) > 0
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(promoted_reasons) AS elem
    WHERE jsonb_typeof(elem) = 'object'
  );
