-- The workspace's PowerPoint template, which the Pipeline "Present" download is branded with.
-- 'default' = the untemplated output; see src/lib/pptx/templates/catalog.ts.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "pptx_template" text NOT NULL DEFAULT 'default';
