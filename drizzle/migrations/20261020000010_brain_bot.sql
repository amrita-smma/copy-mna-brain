-- brain_bot
-- The workspace default bot becomes Brain Bot: every member's primary bot,
-- with its own black "apex" body, never edited or pinned.
-- The app renders its name, look and persona itself
-- (presentBotRow in src/lib/services/botService.ts); this keeps the row in
-- step for anything that reads it directly, such as @mention matching.
UPDATE bots
SET name = 'Brain Bot',
    avatar = '{"hue": 28, "eyes": "round", "mood": "calm", "shape": "apex"}'::jsonb,
    visibility = 'workspace',
    updated_at = now()
WHERE is_default AND archived_at IS NULL;
--> statement-breakpoint
-- No other bot may wear Brain Bot's body.
UPDATE bots
SET avatar = jsonb_set(avatar, '{shape}', '"nova"')
WHERE NOT is_default AND avatar->>'shape' = 'apex';
--> statement-breakpoint
-- Brain Bot always leads every list, so it leaves everyone's pin list.
UPDATE bot_orders o
SET bot_ids = array_remove(o.bot_ids, b.id)
FROM bots b
WHERE b.is_default
  AND b.workspace_id = o.workspace_id
  AND b.id = ANY (o.bot_ids);
