ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "copilot_agent" text NOT NULL DEFAULT 'mna';
