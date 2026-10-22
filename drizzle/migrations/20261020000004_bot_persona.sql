-- bot_persona_and_skills
-- One persona markdown per bot: the user's instructions. Replaces
-- system_prompt, which is kept for one release and dropped in a later
-- migration.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS persona_md TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE bots SET persona_md = system_prompt WHERE persona_md = '' AND system_prompt <> '';
