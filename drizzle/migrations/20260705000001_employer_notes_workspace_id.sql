-- Migration: CRM workspace scoping (MB-337 follow-up) — employer_notes.
-- Created: 2026-07-05
--
-- Notes are always user-authored within a specific workspace (no auto/
-- ingest path), so unlike employers/correspondents this is a plain root-
-- table-style column: add nullable, backfill existing rows to the platform
-- workspace, lock to NOT NULL. Same 3-step pattern as
-- 20260701000004_add_workspace_id_broad.sql.
ALTER TABLE employer_notes ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id);
UPDATE employer_notes SET workspace_id = '00000000-0000-0000-0000-000000000001' WHERE workspace_id IS NULL;
ALTER TABLE employer_notes ALTER COLUMN workspace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employer_notes_workspace_id ON employer_notes(workspace_id);
