-- Migration: MB-337 follow-up — ON DELETE CASCADE for every FK into workspaces.
-- Created: 2026-07-08
--
-- Makes deleting a workspace actually possible. When the workspace tables and
-- the broad workspace_id rollout landed (20260703160001..2, 20260705000001..3),
-- most FKs into workspaces(id) were created with the default NO ACTION, so a
-- DELETE on workspaces would raise a FK violation from any child row. Only
-- user_workspaces and workspace_correspondents were already ON DELETE CASCADE.
--
-- Here we drop and re-add each remaining workspace FK with ON DELETE CASCADE so
-- deleting a workspace tears down all of its owned rows in one statement. This
-- is a constraint swap only — no data changes. DROP CONSTRAINT IF EXISTS keeps
-- it idempotent/safe to re-run. The default constraint names below are the ones
-- Postgres assigned when the columns were added inline (<table>_workspace_id_fkey).

-- companies
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_workspace_id_fkey;
ALTER TABLE companies ADD CONSTRAINT companies_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- investment_thesis
ALTER TABLE investment_thesis DROP CONSTRAINT IF EXISTS investment_thesis_workspace_id_fkey;
ALTER TABLE investment_thesis ADD CONSTRAINT investment_thesis_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- files
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_workspace_id_fkey;
ALTER TABLE files ADD CONSTRAINT files_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- recent_files
ALTER TABLE recent_files DROP CONSTRAINT IF EXISTS recent_files_workspace_id_fkey;
ALTER TABLE recent_files ADD CONSTRAINT recent_files_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- copilot_chats
ALTER TABLE copilot_chats DROP CONSTRAINT IF EXISTS copilot_chats_workspace_id_fkey;
ALTER TABLE copilot_chats ADD CONSTRAINT copilot_chats_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- api_chat_conversations
ALTER TABLE api_chat_conversations DROP CONSTRAINT IF EXISTS api_chat_conversations_workspace_id_fkey;
ALTER TABLE api_chat_conversations ADD CONSTRAINT api_chat_conversations_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- ai_workforce_queue
ALTER TABLE ai_workforce_queue DROP CONSTRAINT IF EXISTS ai_workforce_queue_workspace_id_fkey;
ALTER TABLE ai_workforce_queue ADD CONSTRAINT ai_workforce_queue_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- jobs (nullable workspace_id — CASCADE still applies to the rows that carry one)
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_workspace_id_fkey;
ALTER TABLE jobs ADD CONSTRAINT jobs_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- routines (nullable workspace_id)
ALTER TABLE routines DROP CONSTRAINT IF EXISTS routines_workspace_id_fkey;
ALTER TABLE routines ADD CONSTRAINT routines_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- employer_notes
ALTER TABLE employer_notes DROP CONSTRAINT IF EXISTS employer_notes_workspace_id_fkey;
ALTER TABLE employer_notes ADD CONSTRAINT employer_notes_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- employer_related_companies
ALTER TABLE employer_related_companies DROP CONSTRAINT IF EXISTS employer_related_companies_workspace_id_fkey;
ALTER TABLE employer_related_companies ADD CONSTRAINT employer_related_companies_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- topics (nullable workspace_id — global vocabulary rows have NULL and are untouched)
ALTER TABLE topics DROP CONSTRAINT IF EXISTS topics_workspace_id_fkey;
ALTER TABLE topics ADD CONSTRAINT topics_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
