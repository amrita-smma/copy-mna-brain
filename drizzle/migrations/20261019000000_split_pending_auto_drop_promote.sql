-- split_pending_auto_drop_promote
-- Pending Confirmation's "Auto drop / promote" toggle becomes two independent
-- toggles. Both start from the combined setting so no workspace changes
-- behaviour on deploy. `pending_auto_drop_promote` is no longer read; it is
-- left in place (two-phase drop) and can be removed in a later migration.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS pending_auto_promote boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pending_auto_drop boolean NOT NULL DEFAULT false;

UPDATE workspaces
SET pending_auto_promote = true,
    pending_auto_drop = true
WHERE pending_auto_drop_promote = true;
