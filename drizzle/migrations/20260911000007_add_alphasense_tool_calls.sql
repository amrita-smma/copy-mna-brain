-- add_alphasense_tool_calls
-- One row per alphasense_search tool invocation, for historical lookback on
-- what the agent asked AlphaSense and what came back. chat_thread_id and
-- original_question capture the conversation the call happened in.

CREATE TABLE alphasense_tool_calls (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chat_thread_id     TEXT,
  original_question  TEXT,
  prompt             TEXT NOT NULL,
  conversation_id    TEXT,
  status             TEXT NOT NULL,
  response_markdown  TEXT,
  error_message      TEXT,
  created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alphasense_tool_calls_workspace_id ON alphasense_tool_calls(workspace_id);
CREATE INDEX idx_alphasense_tool_calls_chat_thread_id ON alphasense_tool_calls(chat_thread_id);
CREATE INDEX idx_alphasense_tool_calls_created_at ON alphasense_tool_calls(created_at);

ALTER TABLE alphasense_tool_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read access on alphasense_tool_calls" ON alphasense_tool_calls FOR SELECT USING (true);
CREATE POLICY "Allow insert access on alphasense_tool_calls" ON alphasense_tool_calls FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow update access on alphasense_tool_calls" ON alphasense_tool_calls FOR UPDATE USING (true);
CREATE POLICY "Allow delete access on alphasense_tool_calls" ON alphasense_tool_calls FOR DELETE USING (true);
