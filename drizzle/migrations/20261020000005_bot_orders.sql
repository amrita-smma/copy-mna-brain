-- Each user's own order of the bots in their Copilot strip. One row per user
-- per workspace; bots missing from the list (new, or shared later) sort after
-- the ordered ones. Stale ids (archived bots) are ignored on read.
CREATE TABLE IF NOT EXISTS bot_orders (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bot_ids UUID[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workspace_id)
);
