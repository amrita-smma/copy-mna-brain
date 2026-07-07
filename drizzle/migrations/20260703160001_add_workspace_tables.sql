-- Migration: MB-337 Workspace Management and Configuration — tenancy foundation.
-- Created: 2026-07-01
--
-- Adds the 3 tenancy tables (workspaces, roles, user_workspaces) and
-- backfills them so every existing user lands in one hardcoded seed
-- workspace, "MnA" — see the RFC at Confluence 2612887553. IDs are
-- hardcoded (not gen_random_uuid()) so staging/prod/dev all agree; keep
-- these literals in sync with src/lib/constants.ts (MNA_WORKSPACE_ID,
-- ROLE_ADMIN_ID, ROLE_EDITOR_ID, ROLE_VIEWER_ID).
--
-- Custodian mailbox sync is a per-membership flag (user_workspaces.
-- is_email_synced) rather than a dedicated table: a mailbox being watched
-- for a workspace is just "this user's own email, flagged for this
-- workspace" — there's no case where a watched mailbox isn't also a real
-- user account.

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  CONSTRAINT workspaces_slug_key UNIQUE (slug)
);

CREATE TRIGGER update_workspaces_updated_at
  BEFORE UPDATE ON workspaces
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  CONSTRAINT roles_name_key UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS user_workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id),
  -- The user's own email is the "custodian mailbox" being watched for this
  -- workspace when true.
  is_email_synced BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  CONSTRAINT user_workspaces_user_id_workspace_id_key UNIQUE (user_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_user_workspaces_user_id ON user_workspaces(user_id);
CREATE INDEX IF NOT EXISTS idx_user_workspaces_workspace_id ON user_workspaces(workspace_id);

CREATE TRIGGER update_user_workspaces_updated_at
  BEFORE UPDATE ON user_workspaces
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Seed the platform workspace + roles with fixed ids (must match
-- src/lib/constants.ts exactly).
INSERT INTO workspaces (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000001', 'MnA', 'mna')
ON CONFLICT (id) DO NOTHING;

INSERT INTO roles (id, name)
VALUES
  ('00000000-0000-0000-0000-000000000101', 'admin'),
  ('00000000-0000-0000-0000-000000000102', 'editor'),
  ('00000000-0000-0000-0000-000000000103', 'viewer')
ON CONFLICT (id) DO NOTHING;

-- Backfill: every existing user joins MNA as an Editor (RFC: "Editor //
-- semua orang default kesini" — everyone defaults here).
INSERT INTO user_workspaces (user_id, workspace_id, role_id)
SELECT u.id, '00000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000102'::uuid
FROM users u
ON CONFLICT (user_id, workspace_id) DO NOTHING;

-- Backfill: flag is_email_synced for every MNA member whose own email is
-- already an ingesting custodian mailbox. Without this, the attachment
-- fan-out resolves zero workspaces for an existing mailbox and silently
-- drops new files. Narrower than a mapping-table backfill would be: a
-- custodian mailbox with no matching users row simply doesn't get flagged
-- (there's no user_workspaces row to flag it on) — by design, since a
-- watched mailbox is now defined as "a real user's own email".
-- Guarded by an existence check: app migrations (this file) run entirely
-- before pipeline migrations (scripts/migrate.ts runs drizzle/migrations/
-- then data-pipeline/migrations/ as two separate sequential chains), so on a
-- fresh database analytics.raw_emails doesn't exist yet when this runs. That's
-- fine — a fresh install has no ingest history to backfill anyway. On an
-- existing environment where the table already has rows, the backfill runs
-- as intended.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'analytics' AND table_name = 'raw_emails'
  ) THEN
    UPDATE user_workspaces uw
    SET is_email_synced = true
    FROM users u
    WHERE uw.user_id = u.id
      AND uw.workspace_id = '00000000-0000-0000-0000-000000000001'
      AND u.email IN (
        SELECT DISTINCT re.custodian_email
        FROM analytics.raw_emails re
        WHERE re.custodian_email IS NOT NULL
      );
  END IF;
END $$;
