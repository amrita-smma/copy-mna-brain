ALTER TABLE companies ADD COLUMN IF NOT EXISTS aliases jsonb DEFAULT '[]'::jsonb;
