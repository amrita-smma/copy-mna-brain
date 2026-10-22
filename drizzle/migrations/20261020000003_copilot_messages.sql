-- copilot_messages
-- The Copilot's chat history as rows, so it no longer lives only in LangGraph
-- checkpoints. Each turn stores the user's message and the assistant's reply
-- (UI parts for rendering, plain text for search). History pages from here,
-- survives the summarization middleware and checkpoint compaction, and is
-- searchable by the bots (`search_chat_history`: pgvector + full text).

CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS copilot_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Insertion order within a thread. The paging cursor: a user row and its
  -- reply are written in one statement and can share a created_at.
  seq           BIGINT GENERATED ALWAYS AS IDENTITY,
  chat_id       UUID NOT NULL REFERENCES copilot_chats(id) ON DELETE CASCADE,
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id        UUID REFERENCES bots(id) ON DELETE SET NULL,
  role          TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  -- Set when another bot sent this message (bot-to-bot, fire-and-forget).
  author_bot_id UUID REFERENCES bots(id) ON DELETE SET NULL,
  -- UI message parts, in the shape the messages endpoint returns.
  parts         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Plain text for search. An assistant row holds the whole exchange
  -- (question and answer); tool output and reasoning are left out.
  text          TEXT NOT NULL DEFAULT '',
  -- Titan Embed Text v2, the model user_memories and rss.item_chunks use.
  -- Filled in by the chat_message_embedding job; NULL until then.
  embedding     vector(1024),
  search        tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text, ''))) STORED,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_copilot_messages_chat_seq
  ON copilot_messages (chat_id, seq DESC);
--> statement-breakpoint
-- History search is always scoped to one user in one workspace.
CREATE INDEX IF NOT EXISTS idx_copilot_messages_user_scope
  ON copilot_messages (user_id, workspace_id, created_at DESC) WHERE role = 'assistant';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_copilot_messages_embedding
  ON copilot_messages USING hnsw (embedding vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_copilot_messages_search
  ON copilot_messages USING gin (search);
--> statement-breakpoint
-- When the latest reply was stored, and when the user last read the thread:
-- the bot strip's unread dot is last_message_at > last_read_at.
ALTER TABLE copilot_chats ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMP WITH TIME ZONE;
--> statement-breakpoint
ALTER TABLE copilot_chats ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMP WITH TIME ZONE;
--> statement-breakpoint
-- Set once the thread's checkpoint history has been copied into
-- copilot_messages (threads that predate this table are imported lazily).
ALTER TABLE copilot_chats ADD COLUMN IF NOT EXISTS history_imported_at TIMESTAMP WITH TIME ZONE;
--> statement-breakpoint
-- Per-thread turn lock: a background bot turn and an interactive turn must
-- not write the same checkpoint thread at once.
ALTER TABLE copilot_chats ADD COLUMN IF NOT EXISTS busy_until TIMESTAMP WITH TIME ZONE;
