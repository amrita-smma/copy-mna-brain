-- workforce_queue_schema_delta
-- 2026-05-11
-- Adds the columns/indexes/schema needed to support the AI CoPilot → Workforce
-- handoff flow, on top of the existing ai_workforce_queue table:
--   - origin_routine_id  (nullable FK → routines.id) — set when a queue row was
--     spawned by a routine; null for direct chat handoffs.
--   - idx_ai_workforce_queue_terminal       — list completed runs by ended_at.
--   - idx_ai_workforce_queue_tenant_status  — placeholder for future tenant
--     scoping; tenant_id column itself depends on a `tenants` table that does
--     not yet exist, so we only add the *terminal* index here.
--   - agent_states schema — owned by langgraph-checkpoint-postgres; tables
--     inside are managed by PostgresSaver.setup() at deploy time. We create
--     the schema itself so deploys don't need an extra step.

ALTER TABLE ai_workforce_queue
  ADD COLUMN origin_routine_id uuid REFERENCES routines(id);

CREATE INDEX idx_ai_workforce_queue_origin_routine
  ON ai_workforce_queue (origin_routine_id)
  WHERE origin_routine_id IS NOT NULL;

CREATE INDEX idx_ai_workforce_queue_terminal
  ON ai_workforce_queue (ended_at DESC)
  WHERE status IN ('succeeded', 'failed', 'rejected', 'timed_out');

CREATE SCHEMA IF NOT EXISTS agent_states;

COMMENT ON SCHEMA agent_states IS
  'Owned by @langchain/langgraph-checkpoint-postgres. Tables are created/managed by PostgresSaver.setup(); do not edit directly. thread_id = ai_workforce_queue.id.';

COMMENT ON COLUMN ai_workforce_queue.origin_routine_id IS
  'Routine that scheduled this run, if any. Null for direct chat/api/webhook triggers.';
