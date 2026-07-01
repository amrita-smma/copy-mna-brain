-- MB-336: Cleanup tables
-- Drops tables with no live application usage (schema-only or dead scaffolding):
--   company_criterias        - superseded by screenings/criterias for per-company results
--   deal_stage_history       - never read or written by application code
--   correspondent_companies  - CRM v2 junction table, never queried
--   pending_mutations        - AI Workforce HITL scaffolding, never wired to a service
--   agent_run_events         - repository exists but is never instantiated/consumed
--   migration_notices        - one-off diagnostic log from the 20260426 normalization migration

DROP TABLE IF EXISTS company_criterias;
DROP TABLE IF EXISTS deal_stage_history;
DROP TABLE IF EXISTS correspondent_companies;
DROP TABLE IF EXISTS pending_mutations;
DROP TABLE IF EXISTS agent_run_events;
DROP TABLE IF EXISTS migration_notices;

DROP TYPE IF EXISTS pending_mutation_status;
DROP TYPE IF EXISTS agent_run_event_kind;
