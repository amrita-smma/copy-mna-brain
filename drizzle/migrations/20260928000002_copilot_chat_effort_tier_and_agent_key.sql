-- copilot_chat_effort_tier_and_agent_key
-- Per-thread effort tier chosen by the Auto router (or pinned by the user), so
-- routing runs once per thread and Auto can only escalate. NULL = not yet
-- routed.
ALTER TABLE copilot_chats ADD COLUMN IF NOT EXISTS effort_tier TEXT;
--> statement-breakpoint
-- The agent a thread runs on, pinned on its first turn: a sector agent's
-- registry key, or 'general' for the general CoPilot. NULL = not yet resolved.
ALTER TABLE copilot_chats ADD COLUMN IF NOT EXISTS agent_key TEXT;
--> statement-breakpoint
-- Existing threads ran on the general CoPilot; without this, resuming one from
-- an insight page would switch it to that insight's sector agent.
UPDATE copilot_chats SET agent_key = 'general' WHERE agent_key IS NULL;
