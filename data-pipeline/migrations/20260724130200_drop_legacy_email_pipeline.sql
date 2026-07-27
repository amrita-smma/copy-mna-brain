-- Irreversible cutover: remove the durable, multi-stage email pipeline.
--
-- The replacement stores only CRM facts in analytics.emails and resumable
-- processing cursors in analytics.email_process_runs. MBOX bytes are consumed
-- from Lambda /tmp and are never persisted to S3 or these legacy tables.

SET search_path = analytics, public;

-- Repeat phase0's privacy/integrity cleanup for databases that applied an
-- earlier revision of that migration before this cutover.
DELETE FROM analytics.employer_related_company_evidence
WHERE email_id IS NULL;

UPDATE analytics.employer_related_company_evidence
SET matched_text = NULL
WHERE matched_text IS NOT NULL;

DROP TABLE IF EXISTS analytics.email_attachments;
DROP TABLE IF EXISTS analytics.raw_email_enrichments;
DROP TABLE IF EXISTS analytics.raw_emails;
DROP TABLE IF EXISTS analytics.llm_batches;
DROP TABLE IF EXISTS analytics.domain_classifications;
DROP TABLE IF EXISTS analytics.mbox_files;

-- Remove historical jobs for handlers that no longer exist. job_logs cascade.
DELETE FROM public.jobs
WHERE type::text IN (
  'vault_export',
  'vault_archive',
  'vault_parse',
  'crm_llm_submit',
  'crm_llm_fetch',
  'crm_domain_classify',
  'crm_ingest',
  'attachment_gate',
  'attachment_fetch',
  'attachment_triage',
  'attachment_extract',
  'attachment_upload'
);

-- PostgreSQL cannot remove enum labels in place. Rebuild job_type so the
-- deleted handlers cannot accidentally be dispatched again.
ALTER TABLE public.jobs
  ALTER COLUMN type TYPE text USING type::text;

DROP TYPE public.job_type;

CREATE TYPE public.job_type AS ENUM (
  'slide_generation',
  'market_screening',
  'ai_screening',
  'company_analysis',
  'stuck_cleanup',
  'graph_sync',
  'track_matching'
);

ALTER TABLE public.jobs
  ALTER COLUMN type TYPE public.job_type USING type::public.job_type;
