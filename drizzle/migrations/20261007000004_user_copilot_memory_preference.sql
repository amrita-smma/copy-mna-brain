-- Whether the CoPilot may remember this user across conversations.
--
-- A per-user setting, owned by the user from Profile → Memory — not an admin
-- toggle and not a per-workspace one. Memory is about the person, so the
-- person decides.
--
-- Defaults to true: memory is on for everyone unless they turn it off. The
-- deployment-wide `COPILOT_MEMORY_ENABLED` env kill-switch sits above this; a
-- user's `true` means nothing when the deployment switch is off.
--
-- Turning it off stops both halves (no recall into a turn, no write-back
-- afterwards) but keeps whatever was already learned — "Forget all" on the
-- same tab is the separate, destructive action.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS copilot_memory_enabled boolean NOT NULL DEFAULT true;
