-- Ephemeral email pipeline Phase 0:
-- 1. Add analytics.emails.custodian_email and backfill from raw_emails
-- 2. Rebuild email_workspace without raw_emails join
-- 3. Rekey employer_related_company_evidence off raw_email_id → email_id
-- 4. Clear matched_text (verbatim body quotes) from evidence
-- 5. Null existing analytics.emails.body_text (stop retaining bodies)

SET search_path = analytics, public;

-- ─── 1. custodian_email on emails ────────────────────────────────────────────
ALTER TABLE analytics.emails
  ADD COLUMN IF NOT EXISTS custodian_email TEXT;

UPDATE analytics.emails em
SET custodian_email = re.custodian_email
FROM analytics.raw_emails re
WHERE re.message_id = em.message_id
  AND em.custodian_email IS NULL;

CREATE INDEX IF NOT EXISTS idx_emails_custodian_email
  ON analytics.emails (custodian_email);

-- ─── 2. email_workspace bridge (no raw_emails) ───────────────────────────────
CREATE OR REPLACE VIEW analytics.email_workspace
  WITH (security_invoker = on) AS
SELECT DISTINCT em.id AS email_id, uw.workspace_id
FROM analytics.emails em
JOIN public.users u ON u.email = em.custodian_email
JOIN public.user_workspaces uw ON uw.user_id = u.id AND uw.is_email_synced = true
WHERE em.custodian_email IS NOT NULL;

-- ─── 3. Evidence: fill email_id, drop raw_email_id, clear matched_text ────────
UPDATE analytics.employer_related_company_evidence e
SET email_id = em.id
FROM analytics.raw_emails re
JOIN analytics.emails em ON em.message_id = re.message_id
WHERE e.raw_email_id = re.id
  AND e.email_id IS NULL;

-- Warn, then remove evidence that cannot be rekeyed. Keeping it would preserve
-- a permanently untraceable evidence count after raw_email_id is dropped.
DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM analytics.employer_related_company_evidence
  WHERE email_id IS NULL
    AND raw_email_id IS NOT NULL;
  IF orphan_count > 0 THEN
    RAISE WARNING
      'ephemeral phase0: deleting % evidence row(s) that cannot be rekeyed to analytics.emails',
      orphan_count;
  END IF;
END $$;

DELETE FROM analytics.employer_related_company_evidence
WHERE email_id IS NULL
  AND raw_email_id IS NOT NULL;

UPDATE analytics.employer_related_company_evidence
SET matched_text = NULL;

ALTER TABLE analytics.employer_related_company_evidence
  DROP CONSTRAINT IF EXISTS uq_erce_company_email_text;

ALTER TABLE analytics.employer_related_company_evidence
  DROP CONSTRAINT IF EXISTS employer_related_company_evidence_related_company_id_raw_email_id_matched_text_key;

ALTER TABLE analytics.employer_related_company_evidence
  DROP CONSTRAINT IF EXISTS erce_raw_email_id_fkey;

ALTER TABLE analytics.employer_related_company_evidence
  DROP COLUMN IF EXISTS raw_email_id;

-- Deduplicate before unique (related_company_id, email_id) — keep oldest row.
DELETE FROM analytics.employer_related_company_evidence a
USING analytics.employer_related_company_evidence b
WHERE a.related_company_id = b.related_company_id
  AND a.email_id IS NOT DISTINCT FROM b.email_id
  AND a.id > b.id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'analytics.employer_related_company_evidence'::regclass
      AND conname = 'uq_erce_company_email'
  ) THEN
    ALTER TABLE analytics.employer_related_company_evidence
      ADD CONSTRAINT uq_erce_company_email
      UNIQUE (related_company_id, email_id);
  END IF;
END $$;

-- ─── 4. Scrub retained email bodies on CRM facts ─────────────────────────────
UPDATE analytics.emails SET body_text = NULL WHERE body_text IS NOT NULL;
