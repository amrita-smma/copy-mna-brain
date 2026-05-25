-- Add `message_id` to `emails` so the mbox → DB ingest can be idempotent.
-- Without this, re-running the ingest job would duplicate every row (the
-- table only had an auto-UUID primary key, no natural key from the source).

ALTER TABLE emails ADD COLUMN IF NOT EXISTS message_id TEXT;

-- Partial UNIQUE index: `message_id` is nullable so manual/UI-created emails
-- can omit it, but any two rows that both have a value must be distinct.
CREATE UNIQUE INDEX IF NOT EXISTS uq_emails_message_id
  ON emails (message_id) WHERE message_id IS NOT NULL;
