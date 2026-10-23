-- drop_legacy_related_company_unique
--
-- 20260705000002 widened employer_related_companies' uniqueness to
-- (workspace_id, employer_id, normalized_company_name, source) and meant to
-- drop the old (employer_id, normalized_company_name, source) guard, but
-- named it uq_erc_employer_company_source. The guard was declared inline in
-- 20260611000001, so Postgres had named it
-- employer_related_companies_employer_id_normalized_company_n_key and the
-- DROP ... IF EXISTS matched nothing.
--
-- With both in place, ingest for a mailbox synced into two workspaces fails:
-- upsertAuto writes the same related company once per workspace, and the
-- second row violates the old guard, which its ON CONFLICT target (the
-- workspace-scoped key) does not cover. Drop the old guard by its real name.
ALTER TABLE employer_related_companies
  DROP CONSTRAINT IF EXISTS employer_related_companies_employer_id_normalized_company_n_key;
