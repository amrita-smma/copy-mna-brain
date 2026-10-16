-- ai_screening_task_company_index
-- The Pipeline AI Screening panel's live stream reads the newest ai_screening
-- AI Workforce task per company every few seconds
-- (AiWorkforceQueueRepository.findLatestPerCompanyAtStages).
CREATE INDEX IF NOT EXISTS idx_ai_workforce_queue_ai_screening_company
  ON ai_workforce_queue (workspace_id, (trigger_meta->>'company_id'), created_at DESC)
  WHERE agent_name = 'ai_screening';
