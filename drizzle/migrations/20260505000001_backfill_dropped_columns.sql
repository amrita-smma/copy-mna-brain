-- Migration: Backfill dropped_at and dropped_reason for already-dropped companies.
-- Created: 2026-05-05
--
-- Both updates are guarded by `IS NULL` so this is safe to re-run.
-- Companies dropped before this column existed but with no DROPPED_FROM_* log
-- (e.g. set via direct SQL or seed data) cannot be recovered and will keep
-- NULL values; the dialog handles that with a "No reason was recorded" message.

-- 1. dropped_at = latest DROPPED* log timestamp per company.
UPDATE companies c
SET dropped_at = sub.dropped_at
FROM (
  SELECT DISTINCT ON (cl.company_id)
    cl.company_id,
    cl.created_at AS dropped_at
  FROM company_logs cl
  WHERE cl.action LIKE 'DROPPED%'
  ORDER BY cl.company_id, cl.created_at DESC
) sub
WHERE c.id = sub.company_id
  AND c.status = 'dropped'
  AND c.dropped_at IS NULL;

-- 2. dropped_reason = deal_note closest to dropped_at, within a 10-second window.
--    The original dropDeal flow wrote the log entry and the note in the same
--    request, so the gap is sub-second; 10s is a generous safety margin that
--    still avoids picking up unrelated notes added later.
UPDATE companies c
SET dropped_reason = sub.content
FROM (
  SELECT DISTINCT ON (dn.deal_id)
    dn.deal_id,
    dn.content
  FROM deal_notes dn
  JOIN companies c2 ON c2.id = dn.deal_id
  WHERE c2.status = 'dropped'
    AND c2.dropped_at IS NOT NULL
    AND ABS(EXTRACT(EPOCH FROM (dn.created_at - c2.dropped_at))) <= 10
  ORDER BY dn.deal_id, ABS(EXTRACT(EPOCH FROM (dn.created_at - c2.dropped_at))) ASC
) sub
WHERE c.id = sub.deal_id
  AND c.dropped_reason IS NULL;
