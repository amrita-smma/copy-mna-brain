-- Ephemeral Phase 1: process-run cursor (no body, no S3) + AFD drop_reason.
--
-- email_process_runs identifies a Vault MBOX source by a stable source_key
-- (export_id + zip object name + entry path) rather than an S3 bucket/key —
-- the no-S3 cutover streams each entry from Lambda /tmp and resumes by
-- re-deriving the same source_key on the next poll.

SET search_path = analytics, public;

CREATE TABLE IF NOT EXISTS analytics.email_process_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  export_id       TEXT,
  source_key      TEXT,
  custodian_email TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  message_offset  INT NOT NULL DEFAULT 0,
  messages_seen   INT NOT NULL DEFAULT 0,
  messages_skipped INT NOT NULL DEFAULT 0,
  messages_ingested INT NOT NULL DEFAULT 0,
  attachments_uploaded INT NOT NULL DEFAULT 0,
  fail_count      INT NOT NULL DEFAULT 0,
  error_code      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_process_runs_status
  ON analytics.email_process_runs (status);

-- Resume lookups hit source_key on every poll — index it.
CREATE INDEX IF NOT EXISTS idx_email_process_runs_source_key
  ON analytics.email_process_runs (source_key);

-- Idempotent if an older phase1 create ran without fail_count.
ALTER TABLE analytics.email_process_runs
  ADD COLUMN IF NOT EXISTS fail_count INT NOT NULL DEFAULT 0;

ALTER TABLE public.files
  ADD COLUMN IF NOT EXISTS drop_reason TEXT;
