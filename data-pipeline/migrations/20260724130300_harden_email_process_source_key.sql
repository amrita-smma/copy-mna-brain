-- Upgrade-safe no-S3 cursor invariant.
--
-- This is intentionally separate from phase1 because environments that
-- already journaled phase1 will not execute edits made in place.

SET search_path = analytics, public;

ALTER TABLE analytics.email_process_runs
  ALTER COLUMN export_id TYPE TEXT USING export_id::text;

ALTER TABLE analytics.email_process_runs
  ADD COLUMN IF NOT EXISTS source_key TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'analytics'
      AND table_name = 'email_process_runs'
      AND column_name = 'mbox_s3_key'
  ) THEN
    EXECUTE $sql$
      UPDATE analytics.email_process_runs
      SET source_key = concat_ws('::', export_id, mbox_s3_bucket, mbox_s3_key)
      WHERE source_key IS NULL
    $sql$;
  END IF;
END $$;

UPDATE analytics.email_process_runs
SET source_key = 'legacy-run::' || id::text
WHERE source_key IS NULL;

-- Preserve the most recent cursor at the canonical key. Older duplicate
-- history remains queryable under synthetic unique keys.
WITH duplicate_runs AS (
  SELECT id, row_number() OVER (
    PARTITION BY source_key
    ORDER BY updated_at DESC, id DESC
  ) AS position
  FROM analytics.email_process_runs
)
UPDATE analytics.email_process_runs run
SET source_key = run.source_key || '::legacy-duplicate::' || run.id::text
FROM duplicate_runs duplicate
WHERE run.id = duplicate.id
  AND duplicate.position > 1;

ALTER TABLE analytics.email_process_runs
  ALTER COLUMN source_key SET NOT NULL;

DROP INDEX IF EXISTS analytics.idx_email_process_runs_source_key;
CREATE UNIQUE INDEX idx_email_process_runs_source_key
  ON analytics.email_process_runs (source_key);

ALTER TABLE analytics.email_process_runs
  DROP COLUMN IF EXISTS mbox_s3_bucket,
  DROP COLUMN IF EXISTS mbox_s3_key;
