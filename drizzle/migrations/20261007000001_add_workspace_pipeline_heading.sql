-- add_workspace_pipeline_heading
-- Per-workspace heading for the Deal Pipeline page. Nullable: NULL means "use
-- the product default" ("Deal Pipeline" / "Track companies through all
-- stages"), so an untouched workspace keeps rendering exactly what it does
-- today and clearing the fields restores the defaults.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "pipeline_title" text;
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "pipeline_subtitle" text;
