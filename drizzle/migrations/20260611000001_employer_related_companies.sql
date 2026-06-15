-- Aggregate table: one row per (banker employer × target company) relationship.
-- Lives in public because it FKs only to public.employers and public.companies.
-- Evidence lives in analytics.employer_related_company_evidence (cross-schema safe).
CREATE TABLE IF NOT EXISTS employer_related_companies (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employer_id               UUID NOT NULL REFERENCES employers(id) ON DELETE CASCADE,
  company_id                UUID REFERENCES companies(id) ON DELETE SET NULL,
  company_name              TEXT NOT NULL,
  normalized_company_name   TEXT NOT NULL,
  source                    TEXT NOT NULL DEFAULT 'auto',
  confidence                TEXT NOT NULL DEFAULT 'medium',
  reason                    TEXT NOT NULL,
  reason_summary            TEXT,
  evidence_count            INTEGER NOT NULL DEFAULT 0,
  first_seen_at             TIMESTAMPTZ,
  last_seen_at              TIMESTAMPTZ,
  dismissed_at              TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employer_id, normalized_company_name, source)
);

CREATE INDEX IF NOT EXISTS idx_erc_employer_id
  ON employer_related_companies (employer_id);

CREATE INDEX IF NOT EXISTS idx_erc_company_id
  ON employer_related_companies (company_id);

ALTER TABLE employer_related_companies ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  EXECUTE 'CREATE POLICY "Allow read access on employer_related_companies"   ON employer_related_companies FOR SELECT TO public USING (true)';
  EXECUTE 'CREATE POLICY "Allow insert access on employer_related_companies" ON employer_related_companies FOR INSERT TO public WITH CHECK (true)';
  EXECUTE 'CREATE POLICY "Allow update access on employer_related_companies" ON employer_related_companies FOR UPDATE TO public USING (true)';
  EXECUTE 'CREATE POLICY "Allow delete access on employer_related_companies" ON employer_related_companies FOR DELETE TO public USING (true)';
END $$;
