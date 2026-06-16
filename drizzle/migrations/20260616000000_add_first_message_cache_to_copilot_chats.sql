-- Chat caching: record the first user message of each copilot chat (raw text
-- plus a SHA-256 of its normalized form) so a brand-new chat can detect when
-- it repeats an earlier question. Additive/nullable — non-destructive.
ALTER TABLE copilot_chats ADD COLUMN IF NOT EXISTS first_user_message text;
ALTER TABLE copilot_chats ADD COLUMN IF NOT EXISTS first_user_message_hash text;

COMMENT ON COLUMN copilot_chats.first_user_message IS 'Raw first user message of the chat (for display/debug).';
COMMENT ON COLUMN copilot_chats.first_user_message_hash IS 'SHA-256 of the normalized (trim + lowercase + collapsed whitespace) first user message; lookup key for the chat cache.';

CREATE INDEX IF NOT EXISTS idx_copilot_chats_first_msg_hash
  ON copilot_chats USING btree (first_user_message_hash);
