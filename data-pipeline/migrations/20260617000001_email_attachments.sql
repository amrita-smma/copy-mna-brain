-- MB-214: email attachment pipeline (Phase 1 — metadata capture + gate)
-- Adds four new job_type enum values and the email_attachments table.

ALTER TYPE public.job_type ADD VALUE IF NOT EXISTS 'attachment_gate';
ALTER TYPE public.job_type ADD VALUE IF NOT EXISTS 'attachment_fetch';
ALTER TYPE public.job_type ADD VALUE IF NOT EXISTS 'attachment_triage';
ALTER TYPE public.job_type ADD VALUE IF NOT EXISTS 'attachment_extract';

CREATE TABLE IF NOT EXISTS analytics.email_attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id         UUID NOT NULL REFERENCES analytics.mbox_files(id) ON DELETE CASCADE,
  message_id      TEXT NOT NULL,
  part_index      INTEGER NOT NULL,
  filename        TEXT,
  mime_type       TEXT,
  size_bytes      INTEGER,
  content_hash    TEXT NOT NULL,
  encoding        TEXT,
  state           TEXT NOT NULL DEFAULT 'metadata_only',
  gate_reason     TEXT,
  s3_bucket       TEXT,
  s3_key          TEXT,
  doc_type        TEXT,
  triage_confidence TEXT,
  extracted       JSONB,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetched_at      TIMESTAMPTZ,
  triaged_at      TIMESTAMPTZ,
  extracted_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_attachments_msg_hash
  ON analytics.email_attachments (message_id, content_hash);

CREATE INDEX IF NOT EXISTS idx_email_attachments_state
  ON analytics.email_attachments (state);

CREATE INDEX IF NOT EXISTS idx_email_attachments_file_id
  ON analytics.email_attachments (file_id);

CREATE INDEX IF NOT EXISTS idx_email_attachments_content_hash
  ON analytics.email_attachments (content_hash);
