-- Migration: platform-wide superadmin flag.
--
-- A superadmin manages every workspace (create workspaces, add/remove
-- members, assign per-workspace roles) without needing a user_workspaces
-- row of their own. This is deliberately independent of the per-membership
-- admin/editor/viewer roles in `roles`/`user_workspaces` — those stay scoped
-- to in-workspace concerns only and grant no admin-portal access.
--
-- No account is auto-flagged here (varies per environment); set
-- is_superadmin = true manually for the intended first superadmin(s) after
-- this runs.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN NOT NULL DEFAULT false;
