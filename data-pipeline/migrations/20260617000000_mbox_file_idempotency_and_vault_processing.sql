-- Make Vault archive polling idempotent.
--
-- Older vaultArchivePoll runs could OOM after inserting some mbox_files rows
-- but before marking vault_exports as archived. Retrying that same export then
-- inserted duplicate pending rows for the same S3 object. Keep the first row
-- for each object key, then enforce idempotency at the database boundary.
DELETE FROM analytics.mbox_files
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (PARTITION BY s3_key ORDER BY created_at, id) AS rn
    FROM analytics.mbox_files
  ) ranked
  WHERE rn > 1
);

ALTER TABLE analytics.mbox_files
  ADD CONSTRAINT mbox_files_s3_key_unique UNIQUE (s3_key);

COMMENT ON COLUMN analytics.vault_exports.status IS
  'exporting | processing | completed | failed | archived';
