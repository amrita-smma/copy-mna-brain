-- mbox_files: durable record of every MBOX file archived to S3 from Google Vault.
-- The parse pipeline drains rows WHERE parse_status = 'pending'.

CREATE TABLE IF NOT EXISTS analytics.mbox_files (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source                    TEXT NOT NULL,                 -- 'vault' today; extensible
  s3_bucket                 TEXT NOT NULL,
  s3_key                    TEXT NOT NULL,
  size_bytes                BIGINT NOT NULL,               -- compressed size in S3
  uncompressed_size_bytes   BIGINT,                        -- pre-gzip, for ratio reporting
  custodian_email           TEXT NOT NULL,
  window_start              TIMESTAMPTZ NOT NULL,
  window_end                TIMESTAMPTZ NOT NULL,
  vault_matter_id           TEXT,
  vault_export_id           TEXT,
  mode                      TEXT NOT NULL,                 -- 'monthly' | 'live'
  job_id                    UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  parse_status              TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'parsing'|'parsed'|'failed'
  parsed_at                 TIMESTAMPTZ,
  parse_error               TEXT,
  raw_email_count           INTEGER,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mbox_files_source_window_start
  ON analytics.mbox_files (source, window_start);

CREATE INDEX IF NOT EXISTS idx_mbox_files_parse_status
  ON analytics.mbox_files (parse_status);

CREATE INDEX IF NOT EXISTS idx_mbox_files_job_id
  ON analytics.mbox_files (job_id);

-- raw_emails: structured per-message storage parsed from MBOX files.
-- One row per RFC 5322 message; `message_id` is the dedup key.

CREATE TABLE IF NOT EXISTS analytics.raw_emails (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id             UUID NOT NULL REFERENCES analytics.mbox_files(id) ON DELETE CASCADE,
  custodian_email     TEXT NOT NULL,            -- denormalized from mbox_files
  message_id          TEXT NOT NULL,            -- real ID (no angle brackets) or 'sha256:<hex>'
  from_address        TEXT,
  from_display_name   TEXT,
  to_addresses        JSONB,                    -- array of strings
  cc_addresses        JSONB,                    -- array of strings
  subject             TEXT,
  body_text           TEXT NOT NULL DEFAULT '',
  sent_at             TIMESTAMPTZ,
  has_attachments     BOOLEAN NOT NULL DEFAULT false,
  in_reply_to         TEXT,
  "references"        TEXT,                     -- "references" is a reserved word in some contexts
  gmail_thread_id     TEXT,
  raw_headers         JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  llm_status          TEXT NOT NULL DEFAULT 'pending',
  -- values: pending | in_batch | enriched | not_needed | failed
  ingest_status       TEXT NOT NULL DEFAULT 'pending',
  -- values: pending | ingested | failed
  llm_enriched_at     TIMESTAMPTZ,
  ingested_at         TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_raw_emails_message_id
  ON analytics.raw_emails (message_id);

CREATE INDEX IF NOT EXISTS idx_raw_emails_file_id
  ON analytics.raw_emails (file_id);

CREATE INDEX IF NOT EXISTS idx_raw_emails_sent_at
  ON analytics.raw_emails (sent_at);

CREATE INDEX IF NOT EXISTS idx_raw_emails_custodian_email
  ON analytics.raw_emails (custodian_email);

CREATE INDEX IF NOT EXISTS idx_raw_emails_llm_status
  ON analytics.raw_emails (llm_status);

CREATE INDEX IF NOT EXISTS idx_raw_emails_ingest_status
  ON analytics.raw_emails (ingest_status);

-- llm_batches: tracks each Anthropic Messages Batches submission.

CREATE TABLE IF NOT EXISTS analytics.llm_batches (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anthropic_batch_id   TEXT NOT NULL UNIQUE,
  status               TEXT NOT NULL,           -- 'in_progress' | 'ended' | 'fetched' | 'failed'
  model                TEXT NOT NULL,
  request_count        INTEGER NOT NULL,
  custom_id_map        JSONB NOT NULL,          -- { custom_id: raw_email_id }
  submit_job_id        UUID REFERENCES public.jobs(id) ON DELETE SET NULL,
  fetch_job_id         UUID REFERENCES public.jobs(id) ON DELETE SET NULL,
  submitted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at             TIMESTAMPTZ,
  fetched_at           TIMESTAMPTZ,
  error                TEXT
);

CREATE INDEX IF NOT EXISTS idx_llm_batches_status ON analytics.llm_batches (status);

-- raw_email_enrichments: extract output + LLM output per raw_email.

CREATE TABLE IF NOT EXISTS analytics.raw_email_enrichments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_email_id         UUID NOT NULL UNIQUE REFERENCES analytics.raw_emails(id) ON DELETE CASCADE,

  -- Extract output (deterministic, from processEmail)
  candidates           JSONB,
  domain_tag           TEXT,
  needs_llm            BOOLEAN NOT NULL,
  body_snippet         TEXT,
  extracted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- LLM enrichment output (when needs_llm=true and the batch landed)
  topics               JSONB,
  people               JSONB,
  llm_model            TEXT,
  llm_batch_id         UUID REFERENCES analytics.llm_batches(id) ON DELETE SET NULL,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raw_email_enrichments_needs_llm
  ON analytics.raw_email_enrichments (needs_llm);

CREATE INDEX IF NOT EXISTS idx_raw_email_enrichments_llm_batch_id
  ON analytics.raw_email_enrichments (llm_batch_id);

-- domain_classifications: LLM-derived industry per sender domain.

CREATE TABLE IF NOT EXISTS analytics.domain_classifications (
  domain               TEXT PRIMARY KEY,
  name                 TEXT,
  industry             TEXT,
  confidence           TEXT NOT NULL,           -- 'high' | 'medium' | 'low'
  source               TEXT NOT NULL,           -- 'llm' | 'manual'
  classified_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
