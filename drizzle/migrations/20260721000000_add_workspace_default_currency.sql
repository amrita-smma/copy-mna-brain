ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "default_currency" text NOT NULL DEFAULT 'USD';
