-- MB-223/224/225/226 — origination pipeline triage fields on companies
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS review_state     TEXT    NOT NULL DEFAULT 'reviewed',
  ADD COLUMN IF NOT EXISTS doc_type         TEXT,
  ADD COLUMN IF NOT EXISTS banker_source    TEXT,
  ADD COLUMN IF NOT EXISTS possible_duplicate_company_id UUID
    REFERENCES companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_companies_review_state
  ON companies (review_state);
