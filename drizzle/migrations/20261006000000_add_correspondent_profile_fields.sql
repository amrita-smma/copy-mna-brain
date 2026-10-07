-- Banker profile fields (department, specialization, seniority, coverage,
-- LinkedIn, bio). Mirrors the RFC §3.4 split: a machine column on
-- `correspondents` and a human overlay column on `correspondent_curation`,
-- COALESCEd together by `correspondent_effective`.
--
-- Which side a write lands on depends on the operation: creating a contact
-- writes the base row (origin='manual', which the ETL never touches), while
-- editing an existing one writes only the overlay so a re-ingest can't clobber
-- it. The ingest upsert (`CorrespondentRepository.upsertBatch`) lists none of
-- these columns in its ON CONFLICT set, so it can neither fill nor overwrite
-- them — an enrichment pass can start doing so later without a new migration.
ALTER TABLE correspondents
  ADD COLUMN IF NOT EXISTS department      text,
  ADD COLUMN IF NOT EXISTS specialization  text,
  ADD COLUMN IF NOT EXISTS seniority       text,
  ADD COLUMN IF NOT EXISTS coverage_region text,
  ADD COLUMN IF NOT EXISTS linkedin_url    text,
  ADD COLUMN IF NOT EXISTS bio             text;

ALTER TABLE correspondent_curation
  ADD COLUMN IF NOT EXISTS department      text,
  ADD COLUMN IF NOT EXISTS specialization  text,
  ADD COLUMN IF NOT EXISTS seniority       text,
  ADD COLUMN IF NOT EXISTS coverage_region text,
  ADD COLUMN IF NOT EXISTS linkedin_url    text,
  ADD COLUMN IF NOT EXISTS bio             text;

-- CREATE OR REPLACE VIEW may only APPEND columns — replacing a view cannot
-- reorder or insert into the existing column list. The six new fields
-- therefore land after `updated_at` rather than next to `type`.
CREATE OR REPLACE VIEW correspondent_effective
  WITH (security_invoker = on) AS
SELECT
  co.id,
  co.employer_id,
  COALESCE(cc.name,  co.name)  AS name,
  COALESCE(cc.title, co.title) AS title,
  co.email,                        -- natural key; machine-owned
  COALESCE(cc.phone, co.phone) AS phone,
  COALESCE(cc.type,  co.type)  AS type,
  co.is_primary,                   -- base-only (one-primary unique index enforces)
  co.source,
  co.origin,
  co.last_edited_by_user_id,
  co.last_edited_at,
  co.created_at,
  co.updated_at,
  COALESCE(cc.department,      co.department)      AS department,
  COALESCE(cc.specialization,  co.specialization)  AS specialization,
  COALESCE(cc.seniority,       co.seniority)       AS seniority,
  COALESCE(cc.coverage_region, co.coverage_region) AS coverage_region,
  COALESCE(cc.linkedin_url,    co.linkedin_url)    AS linkedin_url,
  COALESCE(cc.bio,             co.bio)             AS bio
FROM correspondents co
LEFT JOIN correspondent_curation cc ON cc.correspondent_id = co.id;
