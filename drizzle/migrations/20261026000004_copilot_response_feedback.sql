-- copilot_response_feedback (MB-693)
-- A user's feedback on one Copilot reply: thumbs up/down, the reasons picked
-- on a thumbs-down, and an optional written comment. Keyed on the question
-- row (copilot_messages, role 'user') that started the turn — the one id the
-- live stream and a reloaded history share — so one row per user per turn,
-- updated in place when the vote changes. bot_id/model/effort_tier are
-- copied from that question row at write time so feedback can be cut by
-- bot, model and tier without a join. trace_id is the turn's Langfuse trace.

-- The model and effort tier a turn ran on, stamped on its question row when
-- the turn starts. NULL for turns stored before this column existed and for
-- background bot turns.
ALTER TABLE copilot_messages ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE copilot_messages ADD COLUMN IF NOT EXISTS effort_tier TEXT;

CREATE TABLE IF NOT EXISTS copilot_response_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id UUID NOT NULL REFERENCES copilot_chats(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES copilot_messages(id) ON DELETE CASCADE,
  bot_id UUID REFERENCES bots(id) ON DELETE SET NULL,
  trace_id TEXT,
  model TEXT,
  effort_tier TEXT,
  rating SMALLINT CHECK (rating IN (-1, 1)),
  reasons TEXT[] NOT NULL DEFAULT '{}',
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_copilot_response_feedback_user_message
  ON copilot_response_feedback (user_id, message_id);

CREATE INDEX IF NOT EXISTS idx_copilot_response_feedback_chat_id
  ON copilot_response_feedback (chat_id);

CREATE INDEX IF NOT EXISTS idx_copilot_response_feedback_workspace_created
  ON copilot_response_feedback (workspace_id, created_at DESC);
