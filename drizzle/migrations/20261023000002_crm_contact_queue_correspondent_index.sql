-- @crm_contact runs are looked up by the contact they fill:
-- AiWorkforceQueueRepository.findLatestByCorrespondentId(s) (the Profile cell's
-- button) and the hourly auto-enrich sweep's "never enriched here" check
-- (CorrespondentRepository.findNewlyTwoWayWithoutProfile). Same shape as the
-- crm_company_contacts index on company_id.
CREATE INDEX IF NOT EXISTS idx_ai_workforce_queue_crm_contact_correspondent
  ON ai_workforce_queue (workspace_id, (trigger_meta->>'correspondent_id'), created_at DESC)
  WHERE agent_name = 'crm_contact';
