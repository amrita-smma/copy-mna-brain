-- add_bot_routine_job_types
-- Background work for bot routines and the bot task log: a routine's message
-- answered by its bot, and the one-line summary of a task a bot did.
-- Not referenced later in this file: Postgres forbids using an enum value in
-- the same transaction that added it.
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'bot_routine';
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'bot_task_summary';
