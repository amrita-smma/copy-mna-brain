-- The bot avatars were redesigned: five new bodies replace the old five.
-- Move every stored avatar to its closest new body (LEGACY_BOT_SHAPES in
-- src/lib/bots/types.ts); the app also maps an old name it still meets.
UPDATE bots
SET avatar = jsonb_set(
  avatar,
  '{shape}',
  to_jsonb(CASE avatar->>'shape'
    WHEN 'robot' THEN 'pixel'
    WHEN 'capsule' THEN 'nova'
    WHEN 'blob' THEN 'nimbo'
    WHEN 'cat' THEN 'orbit'
    WHEN 'ghost' THEN 'hexa'
  END)
)
WHERE avatar->>'shape' IN ('robot', 'capsule', 'blob', 'cat', 'ghost');
