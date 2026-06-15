-- Add related_companies JSONB column to raw_email_enrichments for raw LLM output.
ALTER TABLE analytics.raw_email_enrichments
  ADD COLUMN IF NOT EXISTS related_companies JSONB;

-- Evidence table for explainability — lives in analytics because it FKs to
-- analytics.emails and analytics.raw_emails (public→analytics FKs are forbidden).
CREATE TABLE IF NOT EXISTS analytics.employer_related_company_evidence (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  related_company_id  UUID NOT NULL REFERENCES public.employer_related_companies(id) ON DELETE CASCADE,
  email_id            UUID REFERENCES analytics.emails(id) ON DELETE CASCADE,
  raw_email_id        UUID REFERENCES analytics.raw_emails(id) ON DELETE CASCADE,
  matched_text        TEXT,
  reason              TEXT NOT NULL,
  reason_summary      TEXT,
  keywords            JSONB,
  confidence          TEXT NOT NULL DEFAULT 'medium',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (related_company_id, raw_email_id, matched_text)
);

CREATE INDEX IF NOT EXISTS idx_erce_related_company_id
  ON analytics.employer_related_company_evidence (related_company_id);

CREATE INDEX IF NOT EXISTS idx_erce_email_id
  ON analytics.employer_related_company_evidence (email_id);
