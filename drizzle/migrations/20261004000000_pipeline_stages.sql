-- pipeline_stages
-- Per-workspace pipeline stages (MB-651). Each workspace names, numbers,
-- describes, orders, adds and deletes its own deal stages.
--
-- `key` is the stage's permanent identity and is what companies.pipeline_stage
-- stores. The six original stages keep the keys L0–L5, so every existing
-- company, log row and stage rule keeps working unchanged; stages a workspace
-- adds get a generated key (`stg-<hex>`). `code` is the editable number shown
-- to users ("L0", "L6", ...), and is unique among a workspace's live stages.
-- Deleting a stage soft-deletes it (`deleted_at`) so dropped deals and stage
-- history can still name it.

CREATE TABLE pipeline_stages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  position     INTEGER NOT NULL,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMP WITH TIME ZONE
);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_pipeline_stages_workspace_key ON pipeline_stages(workspace_id, key);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_pipeline_stages_workspace_live_code
  ON pipeline_stages(workspace_id, lower(code))
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX idx_pipeline_stages_workspace_position ON pipeline_stages(workspace_id, position);
--> statement-breakpoint
CREATE TRIGGER trg_pipeline_stages_updated_at
  BEFORE UPDATE ON pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
-- The default stages every workspace starts with. Used by the backfill below
-- and by the trigger that seeds each new workspace, so no insert path (the
-- workspaces API, seed scripts) can leave a workspace without a pipeline.
CREATE OR REPLACE FUNCTION seed_default_pipeline_stages(target_workspace_id UUID)
RETURNS void AS $$
BEGIN
  INSERT INTO pipeline_stages (workspace_id, key, code, name, description, position)
  VALUES
    (target_workspace_id, 'L0', 'L0', 'Company Sourcing',
      E'Initial company identification and sourcing.\n\nKey deliverables:\n• Sourcing memo\n• Initial thesis fit check', 0),
    (target_workspace_id, 'L1', 'L1', 'Preliminary Review',
      E'First-pass review against the investment thesis: sector, geography and check-size fit, business model and unit economics, management quality, and obvious red flags.\n\nKey deliverables:\n• Screening summary\n• Preliminary financial snapshot', 1),
    (target_workspace_id, 'L2', 'L2', 'Deep Dive',
      E'Deeper analysis of financials and market position.\n\nKey deliverables:\n• Deep dive deck\n• Market & competitive analysis', 2),
    (target_workspace_id, 'L3', 'L3', 'Due Diligence',
      E'Full due diligence and data room review.\n\nKey deliverables:\n• Due diligence report\n• Data room checklist', 3),
    (target_workspace_id, 'L4', 'L4', 'IC Review',
      E'Investment committee presentation and decision.\n\nKey deliverables:\n• IC memo\n• Investment recommendation', 4),
    (target_workspace_id, 'L5', 'L5', 'Closing',
      E'Deal closing and documentation.\n\nKey deliverables:\n• Signed SPA\n• Closing checklist', 5)
  ON CONFLICT (workspace_id, key) DO NOTHING;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION seed_default_pipeline_stages_for_new_workspace()
RETURNS trigger AS $$
BEGIN
  PERFORM seed_default_pipeline_stages(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER trg_workspaces_seed_pipeline_stages
  AFTER INSERT ON workspaces
  FOR EACH ROW EXECUTE FUNCTION seed_default_pipeline_stages_for_new_workspace();
--> statement-breakpoint
-- Every existing workspace, soft-deleted ones included (they can be restored).
SELECT seed_default_pipeline_stages(id) FROM workspaces;
--> statement-breakpoint
-- companies.pipeline_stage moves from the fixed `pipeline_stage` enum to text
-- so it can hold custom stage keys. Existing values are unchanged. The enum's
-- btree index is rebuilt for text; the enum type itself is left in place and
-- dropped in a later migration.
ALTER TABLE companies ALTER COLUMN pipeline_stage DROP DEFAULT;
--> statement-breakpoint
DROP INDEX IF EXISTS idx_companies_pipeline_stage;
--> statement-breakpoint
ALTER TABLE companies ALTER COLUMN pipeline_stage TYPE TEXT USING pipeline_stage::text;
--> statement-breakpoint
ALTER TABLE companies ALTER COLUMN pipeline_stage SET DEFAULT 'L0';
--> statement-breakpoint
CREATE INDEX idx_companies_pipeline_stage ON companies USING btree (pipeline_stage);
