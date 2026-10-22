-- bot_routines
-- A routine that belongs to a Copilot bot: when it fires it sends its prompt
-- to the bot as the routine's creator, in the creator's chat with the bot.
-- Workforce routines keep bot_id NULL.
ALTER TABLE routines
  ADD COLUMN IF NOT EXISTS bot_id UUID REFERENCES bots(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_routines_bot_id
  ON routines (bot_id)
  WHERE bot_id IS NOT NULL AND archived_at IS NULL;
