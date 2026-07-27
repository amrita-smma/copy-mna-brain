-- Durable AFD upload idempotency for mid-message retries.
--
-- When vault-archive-poll soft-retries a source after a later attachment
-- upload fails, earlier attachments on the same message must not be
-- re-uploaded under new S3 keys. Digests are sha256 hex of decoded bytes.

SET search_path = analytics, public;

ALTER TABLE analytics.email_process_runs
  ADD COLUMN IF NOT EXISTS afd_uploaded_digests JSONB NOT NULL DEFAULT '[]'::jsonb;
