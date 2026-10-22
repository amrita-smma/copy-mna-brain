-- bot_requests
-- A request one bot made to another by @mention, so the asking bot always
-- hears back: the answering bot's job closes the row (answer or failure),
-- the last close in a group (every bot one reply asked) dispatches one
-- bot_reply turn to the asker, and the dispatch cron times out rows nobody
-- closed. `bot_reply` is that turn's job type; not referenced later in this
-- file (Postgres forbids using an enum value in the transaction that added it).
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'bot_reply';

CREATE TABLE IF NOT EXISTS bot_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The asking turn: every request one reply made shares it.
  group_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  from_bot_name TEXT NOT NULL,
  from_chat_id UUID NOT NULL REFERENCES copilot_chats(id) ON DELETE CASCADE,
  to_bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  to_bot_name TEXT NOT NULL,
  -- What the asker wrote, clipped.
  ask TEXT NOT NULL,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'done', 'failed', 'timed_out')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bot_requests_group ON bot_requests (group_id);
-- The sweep's read: open requests, oldest first.
CREATE INDEX IF NOT EXISTS idx_bot_requests_pending
  ON bot_requests (created_at) WHERE status = 'pending';
