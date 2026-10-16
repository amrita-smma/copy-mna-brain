-- link_company_crm_employer
-- Links a pipeline company to the CRM employer that IS that company, so the
-- partnership contacts @crm_contact finds for it are filed as ordinary CRM
-- correspondents. See docs/features/company-contacts.md.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS crm_employer_id uuid
  REFERENCES employers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_companies_crm_employer_id
  ON companies USING btree (crm_employer_id)
  WHERE crm_employer_id IS NOT NULL;

-- The Contact Details card reads the newest crm_company_contacts run per
-- company on open and every few seconds while one runs
-- (AiWorkforceQueueRepository.findLatestByCompanyId).
CREATE INDEX IF NOT EXISTS idx_ai_workforce_queue_company_contacts_company
  ON ai_workforce_queue (workspace_id, (trigger_meta->>'company_id'), created_at DESC)
  WHERE agent_name = 'crm_company_contacts';
