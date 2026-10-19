-- drop_pending_auto_drop_promote
-- Second phase of splitting Pending Confirmation's "Auto drop / promote"
-- toggle: pending_auto_promote / pending_auto_drop were backfilled from it in
-- 20261019000000 and the code no longer reads or writes it.
ALTER TABLE workspaces DROP COLUMN IF EXISTS pending_auto_drop_promote;
