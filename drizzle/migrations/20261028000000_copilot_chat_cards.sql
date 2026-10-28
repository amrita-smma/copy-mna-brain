-- copilot_chat_cards
-- A card in a Copilot reply that waits on the user (an approval, a set of
-- options, a Workforce hand-off) and what the user decided on it. Until now
-- the decision lived only in the browser's localStorage: it did not follow
-- the user to another device, and the agent never learned it. A card is
-- registered 'pending' when the turn that offered it is stored; the decision
-- is written when the user acts on it. card_id is the payload's own id
-- (approval_id / card_id / handoff_id), unique per chat.

CREATE TABLE IF NOT EXISTS copilot_chat_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chat_id UUID NOT NULL REFERENCES copilot_chats(id) ON DELETE CASCADE,
  message_id UUID REFERENCES copilot_messages(id) ON DELETE SET NULL,
  card_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT copilot_chat_cards_status_check CHECK (status IN ('pending', 'accepted', 'declined')),
  resolution_text TEXT,
  decision_data JSONB,
  decided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_copilot_chat_cards_chat_card
  ON copilot_chat_cards (chat_id, card_id);

CREATE INDEX IF NOT EXISTS idx_copilot_chat_cards_chat_created
  ON copilot_chat_cards (chat_id, created_at DESC);
