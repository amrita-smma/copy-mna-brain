-- ai_workforce_tables
-- 2026-05-07 — MB-143
-- Creates the database substrate for AI Workforce: queue, events, mutations, routines.
-- See:
--   - https://smma-sqe.atlassian.net/wiki/spaces/mnabrain/pages/2494758917 (main RFC)
--   - https://smma-sqe.atlassian.net/wiki/spaces/mnabrain/pages/2498822148 (§3.8 Streaming)
--   - https://smma-sqe.atlassian.net/wiki/spaces/mnabrain/pages/2498887746 (§3.9 Routines)
--   - https://smma-sqe.atlassian.net/wiki/spaces/mnabrain/pages/2499969029 (Queueing logic)

-- ============================================================================
-- Enums
-- ============================================================================

CREATE TYPE workforce_status AS ENUM (
  'pending',
  'running',
  'waiting_for_human_input',
  'waiting_for_subagent',
  'resume_ready',
  'succeeded',
  'failed',
  'rejected',
  'timed_out'
);

CREATE TYPE trigger_source AS ENUM ('chat', 'cron', 'webhook', 'api');

CREATE TYPE schedule_kind AS ENUM ('daily', 'weekly', 'monthly', 'cron');

CREATE TYPE pending_mutation_status AS ENUM (
  'pending',
  'approved',
  'rejected',
  'timed_out'
);

CREATE TYPE agent_run_event_kind AS ENUM (
  'assistant_message',
  'tool_call',
  'tool_result',
  'subagent_dispatch',
  'mutation_proposed',
  'mutation_resolved',
  'checkpoint_saved',
  'checkpoint_loaded',
  'node_update',
  'token_chunk',
  'error'
);

-- ============================================================================
-- ai_workforce_queue
-- One row per agent run (queue + state machine + run record).
-- The id is also used as the LangGraph thread_id for the agent_states schema.
-- ============================================================================

CREATE TABLE ai_workforce_queue (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_run_id      uuid REFERENCES ai_workforce_queue(id),
  agent_name         text NOT NULL,
  trigger_source     trigger_source NOT NULL,
  trigger_meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             workforce_status NOT NULL DEFAULT 'pending',
  priority           integer NOT NULL DEFAULT 0,
  resume_token       text,
  resume_reason      text,
  workflow_run_id    text,
  last_heartbeat_at  timestamptz,
  input              jsonb NOT NULL,
  output             jsonb,
  error              jsonb,
  cost_cents         integer,
  token_input        integer,
  token_output       integer,
  created_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  ended_at           timestamptz,
  idempotency_key    text UNIQUE
);

-- Dispatcher hot paths — partial indexes match the dispatcher's queries verbatim.
CREATE INDEX idx_ai_workforce_queue_running
  ON ai_workforce_queue (status)
  WHERE status = 'running';

CREATE INDEX idx_ai_workforce_queue_resume_ready
  ON ai_workforce_queue (priority DESC, created_at ASC)
  WHERE status = 'resume_ready';

CREATE INDEX idx_ai_workforce_queue_pending
  ON ai_workforce_queue (priority DESC, created_at ASC)
  WHERE status = 'pending';

-- Reaper hot path — find stuck running rows by stale heartbeat.
CREATE INDEX idx_ai_workforce_queue_heartbeat
  ON ai_workforce_queue (last_heartbeat_at)
  WHERE status = 'running';

-- Subagent traversal.
CREATE INDEX idx_ai_workforce_queue_parent
  ON ai_workforce_queue (parent_run_id);

-- Routine history lookups: WHERE trigger_meta->>'routine_id' = $1
CREATE INDEX idx_ai_workforce_queue_routine
  ON ai_workforce_queue ((trigger_meta->>'routine_id'))
  WHERE trigger_source = 'cron';

COMMENT ON COLUMN ai_workforce_queue.id IS
  'Also used as the LangGraph thread_id in the agent_states schema.';
COMMENT ON COLUMN ai_workforce_queue.trigger_meta IS
  'Polymorphic per trigger_source. For cron: {routine_id, fired_at}. For webhook: {provider_id}. Etc.';
COMMENT ON COLUMN ai_workforce_queue.resume_token IS
  'LangGraph checkpoint_id; non-null when row is in waiting_for_human_input/waiting_for_subagent/resume_ready.';
COMMENT ON COLUMN ai_workforce_queue.last_heartbeat_at IS
  'Updated periodically by the workflow while running. Reaper detects stale rows by checking now() - last_heartbeat_at > SLA.';
COMMENT ON COLUMN ai_workforce_queue.resume_reason IS
  'Why row transitioned to resume_ready (e.g. HITL_APPROVED, SUBAGENT_FINALIZED). Telemetry only; not consumed by dispatcher.';

-- ============================================================================
-- agent_run_events
-- Append-only audit/replay log + SSE streaming substrate.
-- token_chunk rows are ephemeral and deletable after the run terminates.
-- ============================================================================

CREATE TABLE agent_run_events (
  id          bigserial PRIMARY KEY,
  run_id      uuid NOT NULL REFERENCES ai_workforce_queue(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  kind        agent_run_event_kind NOT NULL,
  payload     jsonb NOT NULL,
  latency_ms  integer,
  tokens_in   integer,
  tokens_out  integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE INDEX idx_agent_run_events_run
  ON agent_run_events (run_id, seq);

COMMENT ON COLUMN agent_run_events.kind IS
  'token_chunk is ephemeral (deletable after run terminates). Other kinds are retained for audit.';
COMMENT ON COLUMN agent_run_events.seq IS
  'Monotonic per run, used as SSE Last-Event-ID and to order the trace view.';

-- ============================================================================
-- pending_mutations
-- HITL approval cards. Paired one-to-one with a queue row in
-- waiting_for_human_input status.
-- ============================================================================

CREATE TABLE pending_mutations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL REFERENCES ai_workforce_queue(id) ON DELETE CASCADE,
  tool_name        text NOT NULL,
  proposed_diff    jsonb NOT NULL,
  human_summary    text NOT NULL,
  status           pending_mutation_status NOT NULL DEFAULT 'pending',
  resolved_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at      timestamptz,
  resolution_note  text,
  applied_result   jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL
);

CREATE INDEX idx_pending_mutations_run
  ON pending_mutations (run_id);

CREATE INDEX idx_pending_mutations_status
  ON pending_mutations (status)
  WHERE status = 'pending';

COMMENT ON COLUMN pending_mutations.proposed_diff IS
  'Structured diff: {table, op, before, after} or whatever the tool''s buildDiff produced.';
COMMENT ON COLUMN pending_mutations.human_summary IS
  'Agent-authored explanation rendered on the approval card.';

-- ============================================================================
-- routines
-- User-defined recurring agent jobs (cron-driven).
-- ============================================================================

CREATE TABLE routines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title             text NOT NULL,
  prompt            text NOT NULL,
  schedule_kind     schedule_kind NOT NULL,
  schedule_spec     jsonb NOT NULL,
  cron_expression   text NOT NULL,
  timezone          text NOT NULL DEFAULT 'UTC',
  agent_name        text,
  priority          integer NOT NULL DEFAULT 0,
  enabled           boolean NOT NULL DEFAULT true,
  last_fired_at     timestamptz,
  next_fire_at      timestamptz,
  created_by        uuid NOT NULL REFERENCES users(id),
  updated_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz
);

-- Dispatcher hot path: SELECT * FROM routines WHERE enabled AND archived_at IS NULL AND next_fire_at <= now()
CREATE INDEX idx_routines_active_due
  ON routines (next_fire_at)
  WHERE enabled = true AND archived_at IS NULL;

COMMENT ON COLUMN routines.schedule_kind IS
  'daily | weekly | monthly | cron. Drives schedule_spec shape and UI rendering.';
COMMENT ON COLUMN routines.schedule_spec IS
  'Shape depends on schedule_kind. daily: {time}. weekly: {time, weekdays}. monthly: {time, day_of_month}. cron: {expression}.';
COMMENT ON COLUMN routines.cron_expression IS
  'Canonical cron expression used by the dispatcher. Always derived from schedule_kind + schedule_spec.';
COMMENT ON COLUMN routines.next_fire_at IS
  'Pre-computed next-fire timestamp. Updated on save and after each successful fire. Not backfilled on enable.';

CREATE TRIGGER trg_routines_updated_at
  BEFORE UPDATE ON routines
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
