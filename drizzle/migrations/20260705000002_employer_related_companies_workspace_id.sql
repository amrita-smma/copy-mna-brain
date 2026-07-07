-- Migration: CRM workspace scoping (MB-337 follow-up) — employer_related_companies.
-- Created: 2026-07-05
--
-- Unlike employer/correspondent identity, an employer-to-company link is
-- inherently tied to one workspace's deal context (company_id already
-- points at a workspace-scoped `companies` row). Both write paths that
-- populate this table — crmIngest's auto match and the manual
-- "link to company" action — already distinguish themselves via `source`,
-- so `workspace_id` is stamped directly at write time in both, not derived
-- through the (nullable) company_id FK. Same 3-step pattern as
-- 20260701000004_add_workspace_id_broad.sql.
ALTER TABLE employer_related_companies ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id);
UPDATE employer_related_companies SET workspace_id = '00000000-0000-0000-0000-000000000001' WHERE workspace_id IS NULL;
ALTER TABLE employer_related_companies ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_erc_workspace_id ON employer_related_companies(workspace_id);

-- The old uniqueness guard (employer_id, normalized_company_name, source)
-- would otherwise block two different workspaces from independently
-- matching/linking the same employer to a same-named company. Widen it to
-- include workspace_id — crmIngest's upsertAuto onConflict target must move
-- in the same change (see EmployerRelatedCompanyRepository.upsertAuto).
ALTER TABLE employer_related_companies DROP CONSTRAINT IF EXISTS uq_erc_employer_company_source;
ALTER TABLE employer_related_companies ADD CONSTRAINT uq_erc_workspace_employer_company_source
  UNIQUE (workspace_id, employer_id, normalized_company_name, source);
