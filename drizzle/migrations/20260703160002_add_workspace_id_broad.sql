-- Migration: MB-337 Workspace Management and Configuration — workspace_id rollout.
-- Created: 2026-07-01
--
-- Adds workspace_id only to root/non-derived tables (per the RFC's Story-1/3
-- table inventory). Two-phase per table: add nullable, backfill existing
-- rows to the platform workspace (00000000-0000-0000-0000-000000000001 —
-- MNA_WORKSPACE_ID in src/lib/constants.ts), then lock to NOT NULL.
-- `jobs` and `routines` stay nullable — see the column comments below for why.
--
-- Tables that are 1:1/N:1 children of `companies` (via a NOT NULL
-- `company_id`/`deal_id`) or of `investment_thesis` (via a NOT NULL
-- `track_id`) deliberately do NOT get their own workspace_id column here —
-- company_assignees, company_logs, screenings, deal_notes, deal_links,
-- deal_documents, company_analyses, company_slides, company_financials,
-- company_fx_adjustments, company_screening_derived, user_company_favorites,
-- track_variables, criterias. Giving each of these a second copy of
-- workspace_id risks it drifting from the parent's; they're scoped by
-- joining to the parent instead (see src/lib/repositories/*).
-- `criterias.investment_thesis_id` is made NOT NULL in a later migration
-- (20260702000001) so it always has a parent to derive workspace_id from.
--
-- CRM tables (employers, correspondents, topics, ...) and every
-- `analytics`-schema table are intentionally left untouched: CRM stays
-- shared across workspaces per the RFC, and the pipeline scopes at the
-- `files` promotion boundary only.

-- companies
ALTER TABLE companies ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id);
UPDATE companies SET workspace_id = '00000000-0000-0000-0000-000000000001' WHERE workspace_id IS NULL;
ALTER TABLE companies ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_companies_workspace_id ON companies(workspace_id);

-- investment_thesis
ALTER TABLE investment_thesis ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id);
UPDATE investment_thesis SET workspace_id = '00000000-0000-0000-0000-000000000001' WHERE workspace_id IS NULL;
ALTER TABLE investment_thesis ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_investment_thesis_workspace_id ON investment_thesis(workspace_id);

-- files (the attachment-pipeline fan-out target)
ALTER TABLE files ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id);
UPDATE files SET workspace_id = '00000000-0000-0000-0000-000000000001' WHERE workspace_id IS NULL;
ALTER TABLE files ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_files_workspace_id ON files(workspace_id);

-- recent_files
ALTER TABLE recent_files ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id);
UPDATE recent_files SET workspace_id = '00000000-0000-0000-0000-000000000001' WHERE workspace_id IS NULL;
ALTER TABLE recent_files ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recent_files_workspace_id ON recent_files(workspace_id);

-- copilot_chats
ALTER TABLE copilot_chats ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id);
UPDATE copilot_chats SET workspace_id = '00000000-0000-0000-0000-000000000001' WHERE workspace_id IS NULL;
ALTER TABLE copilot_chats ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_copilot_chats_workspace_id ON copilot_chats(workspace_id);

-- api_chat_conversations
ALTER TABLE api_chat_conversations ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id);
UPDATE api_chat_conversations SET workspace_id = '00000000-0000-0000-0000-000000000001' WHERE workspace_id IS NULL;
ALTER TABLE api_chat_conversations ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_api_chat_conversations_workspace_id ON api_chat_conversations(workspace_id);

-- ai_workforce_queue
ALTER TABLE ai_workforce_queue ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id);
UPDATE ai_workforce_queue SET workspace_id = '00000000-0000-0000-0000-000000000001' WHERE workspace_id IS NULL;
ALTER TABLE ai_workforce_queue ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_workforce_queue_workspace_id ON ai_workforce_queue(workspace_id);

-- jobs: stays nullable. Pipeline job types (vault_export, crm_ingest,
-- attachment_*) and the stuck_cleanup sweep run at the mailbox/system level,
-- before any workspace fan-out — they're correctly unbackfilled (NULL).
-- Only per-company job types (ai_screening, market_screening, slide_generation,
-- track_matching, graph_sync) get a value, stamped by the workspace-bound
-- JobDispatcher going forward.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id);
CREATE INDEX IF NOT EXISTS idx_jobs_workspace_id ON jobs(workspace_id);

-- routines: stays nullable. is_system routines are platform-wide and have no
-- single owning workspace; only user/thesis-driven routines (is_system = false)
-- backfill to the platform workspace.
ALTER TABLE routines ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id);
UPDATE routines SET workspace_id = '00000000-0000-0000-0000-000000000001' WHERE workspace_id IS NULL AND is_system = false;
CREATE INDEX IF NOT EXISTS idx_routines_workspace_id ON routines(workspace_id);
