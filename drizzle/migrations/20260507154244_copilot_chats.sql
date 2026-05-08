-- copilot_chats
-- 2026-05-07 — MB-143 (follow-up for chat_history per ticket title)
-- One row per chat session. The id is the LangGraph thread_id;
-- messages and intermediate state live in agent_states.* (managed by
-- @langchain/langgraph-checkpoint-postgres at runtime).

CREATE TABLE copilot_chats (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_active_at  timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
);

-- Sidebar query: WHERE user_id = $1 AND archived_at IS NULL ORDER BY last_active_at DESC
CREATE INDEX idx_copilot_chats_user_active
  ON copilot_chats (user_id, last_active_at DESC)
  WHERE archived_at IS NULL;

COMMENT ON COLUMN copilot_chats.id IS
  'Also used as the LangGraph thread_id for the agent_states schema (same pattern as ai_workforce_queue.id).';
COMMENT ON COLUMN copilot_chats.title IS
  'LLM-generated after the first turn. Nullable while the chat is empty.';
COMMENT ON COLUMN copilot_chats.last_active_at IS
  'Updated on every user message. Used for sidebar sorting and the 90-day auto-archive sweep.';
COMMENT ON COLUMN copilot_chats.archived_at IS
  'Soft-delete. Set automatically when last_active_at < now() - 90 days. Hard-delete (with cascade to checkpoints) after archived for 1 year.';
