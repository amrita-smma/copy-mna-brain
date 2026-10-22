-- copilot_bots
-- Copilot bots (RFC 02): a named assistant built on a Copilot flavour, with
-- its own prompt and an avatar. Every bot has every skill (in code).
-- Each user gets one permanent chat thread per bot.

CREATE TABLE bots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- NULL for the workspace's system (default) bot.
  owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  -- A CopilotAgentType key ('mna', 'vc', ...).
  base_flavor   TEXT NOT NULL DEFAULT 'mna',
  -- { hue, eyes, mood } for the animated avatar.
  avatar        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 'private' (owner only) | 'workspace' (every member).
  visibility    TEXT NOT NULL DEFAULT 'private',
  is_default    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  archived_at   TIMESTAMP WITH TIME ZONE
);
--> statement-breakpoint
CREATE INDEX idx_bots_workspace_archived ON bots(workspace_id, archived_at);
--> statement-breakpoint
-- At most one default bot per workspace; lets the lazy ensure-default insert
-- use ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX uq_bots_workspace_default ON bots(workspace_id) WHERE is_default;
--> statement-breakpoint
CREATE TRIGGER trg_bots_updated_at
  BEFORE UPDATE ON bots
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
ALTER TABLE copilot_chats ADD COLUMN IF NOT EXISTS bot_id UUID REFERENCES bots(id) ON DELETE CASCADE;
--> statement-breakpoint
-- One permanent thread per user per bot. Legacy chats keep bot_id NULL.
CREATE UNIQUE INDEX uq_copilot_chats_user_bot
  ON copilot_chats(user_id, workspace_id, bot_id) WHERE bot_id IS NOT NULL;
--> statement-breakpoint
-- Every existing workspace gets a default bot on its current flavour.
INSERT INTO bots (workspace_id, name, base_flavor, visibility, is_default, avatar)
SELECT w.id, 'Copilot', w.copilot_agent, 'workspace', true,
       '{"hue": 222, "eyes": "round", "mood": "cheerful"}'::jsonb
FROM workspaces w
ON CONFLICT DO NOTHING;
