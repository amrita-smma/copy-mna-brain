-- drop_copilot_chat_stop_requested
-- Stop now reaches a running turn through Redis (src/lib/bots/presence.ts),
-- not a column it polled. The column's own migration was removed from this
-- branch; this drops it from any database that already made it.
ALTER TABLE copilot_chats DROP COLUMN IF EXISTS stop_requested_at;
