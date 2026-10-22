-- add_bot_job_types
-- Background work for Copilot bots: embedding a stored chat exchange for
-- history search, and a bot answering a message another bot sent it.
-- Not referenced later in this file: Postgres forbids using an enum value in
-- the same transaction that added it.
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'chat_message_embedding';
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'bot_message';
