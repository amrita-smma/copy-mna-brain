-- Migration: CRM workspace scoping (MB-337 follow-up) — correspondent visibility.
-- Created: 2026-07-05
--
-- `employers`/`correspondents` stay shared, global identity tables (see
-- 20260701000004_add_workspace_id_broad.sql's comment) — two workspaces
-- ingesting the same domain must resolve to the same employer/correspondent
-- row, and analytics.email_participants.correspondent_id already points at
-- exactly one shared row per real email. Duplicating identity per workspace
-- would break that FK.
--
-- What workspaces actually need is per-workspace *visibility*: a workspace
-- should only see the contacts sourced from its own custodian mailboxes,
-- plus whatever it manually added. This table is that visibility layer — a
-- plain, add-only membership junction, not a second copy of contact data.
-- Populated by crmIngest (one row per resolved target workspace for each
-- email a correspondent appears in) and by manual "add contact" (one row for
-- the acting workspace). No new table precedent for RLS policies — matches
-- 20260701000003_add_workspace_tables.sql (workspaces/roles/user_workspaces),
-- which also skip them.
CREATE TABLE IF NOT EXISTS workspace_correspondents (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  correspondent_id UUID NOT NULL REFERENCES correspondents(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  PRIMARY KEY (workspace_id, correspondent_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_correspondents_correspondent_id
  ON workspace_correspondents(correspondent_id);

-- Backfill: every existing correspondent becomes visible to MNA, the only
-- workspace that exists today. Without this, the table ships empty and
-- every read that now gates on membership (CorrespondentRepository,
-- EmployerRepository.list) would show nothing until a fresh ingest
-- repopulates it.
INSERT INTO workspace_correspondents (workspace_id, correspondent_id)
SELECT '00000000-0000-0000-0000-000000000001', id FROM correspondents
ON CONFLICT (workspace_id, correspondent_id) DO NOTHING;
