-- bot_task_logs
-- Each bot's task log: a one-line summary of every task it did — in a chat,
-- for an @mention, or for a routine. A user sees the tasks from their own
-- chats with the bot plus every routine run (routines on a shared bot are
-- shared).
CREATE TABLE IF NOT EXISTS bot_task_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id UUID REFERENCES copilot_chats(id) ON DELETE CASCADE,
  routine_id UUID REFERENCES routines(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('chat', 'mention', 'routine')),
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_task_logs_bot_created
  ON bot_task_logs (bot_id, created_at DESC, id DESC);
