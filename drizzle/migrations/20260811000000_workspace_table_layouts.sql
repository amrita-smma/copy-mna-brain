-- Per-workspace table column layouts (order / hidden / collapsible groups).
-- One row = one table's layout for one workspace, shared by every member of
-- that workspace. Replaces the previous per-browser localStorage persistence.
CREATE TABLE IF NOT EXISTS "workspace_table_layouts" (
  "workspace_id" uuid NOT NULL,
  "table_id" text NOT NULL,
  "layout" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid,
  CONSTRAINT "workspace_table_layouts_pkey" PRIMARY KEY ("workspace_id", "table_id")
);

DO $$ BEGIN
  ALTER TABLE "workspace_table_layouts"
    ADD CONSTRAINT "workspace_table_layouts_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "workspace_table_layouts"
    ADD CONSTRAINT "workspace_table_layouts_updated_by_fkey"
    FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
