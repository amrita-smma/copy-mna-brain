-- bot_user_memories
-- What one bot remembers about one user: the notes the user asked that bot
-- to keep about them (preferences, standing requests, how to answer), as a
-- jsonb array of {text, created_at}. One row per user per bot, read into
-- that user's turns with that bot only. The persona stays the bot's
-- behaviour for everyone; this is what is particular to one person.
CREATE TABLE IF NOT EXISTS bot_user_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notes JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_user_memories_bot_user
  ON bot_user_memories (bot_id, user_id);
