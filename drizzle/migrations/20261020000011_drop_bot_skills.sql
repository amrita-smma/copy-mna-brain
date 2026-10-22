-- drop_bot_skills
-- Every bot has every skill now, so bots no longer store a skill list. The
-- column is gone from the create migration; this drops it from any database
-- that already made it.
ALTER TABLE bots DROP COLUMN IF EXISTS skills;
