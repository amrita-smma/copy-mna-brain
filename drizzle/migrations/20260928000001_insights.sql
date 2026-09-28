-- insights
-- Insights: one self-contained HTML document per version, plus the templates
-- they start from, and the routine/queue columns that refresh them on a
-- schedule.

CREATE TABLE insight_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  icon         TEXT,
  html         TEXT NOT NULL,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  -- Soft delete: set while the template sits in Recently deleted.
  deleted_at   TIMESTAMP WITH TIME ZONE
);
--> statement-breakpoint
CREATE INDEX idx_insight_templates_workspace_id ON insight_templates(workspace_id);
--> statement-breakpoint
CREATE TRIGGER trg_insight_templates_updated_at
  BEFORE UPDATE ON insight_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
CREATE TABLE insights (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  description        TEXT,
  -- 'document' is freeform; a 'report' is planned first and held to a
  -- structural contract.
  kind               TEXT NOT NULL DEFAULT 'document',
  is_featured        BOOLEAN NOT NULL DEFAULT false,
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  archived_at        TIMESTAMP WITH TIME ZONE,
  -- The bound sector agent's registry key; null means the general CoPilot.
  -- No FK: the registry is code (src/lib/agents/sector/registry.ts).
  agent_key          TEXT,
  source_template_id UUID REFERENCES insight_templates(id) ON DELETE SET NULL,
  CONSTRAINT chk_insights_kind CHECK (kind IN ('document', 'report'))
);
--> statement-breakpoint
CREATE INDEX idx_insights_workspace_id ON insights(workspace_id);
--> statement-breakpoint
-- Per-template usage counts on the template library.
CREATE INDEX idx_insights_workspace_source_template
  ON insights(workspace_id, source_template_id);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_insights_workspace_featured
  ON insights(workspace_id)
  WHERE is_featured AND archived_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER trg_insights_updated_at
  BEFORE UPDATE ON insights
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
--> statement-breakpoint
-- Every HTML an insight has had, append-only; the highest version_no is
-- current, and a rollback appends an old version's HTML as a new one.
CREATE TABLE insight_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  insight_id    UUID NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  version_no    INTEGER NOT NULL,
  -- Rendered only inside a sandboxed iframe, never injected into the app
  -- origin, so it is stored exactly as authored.
  html          TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  label         TEXT,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  -- The workforce run that published the version.
  source_run_id UUID REFERENCES ai_workforce_queue(id) ON DELETE SET NULL,
  -- sha256 of the whitespace-normalised HTML, so a scheduled refresh that
  -- changed nothing records an unchanged version instead of notifying.
  content_hash  TEXT,
  is_unchanged  BOOLEAN NOT NULL DEFAULT false,
  -- The sector agent that produced the version; null when none did.
  agent_key     TEXT,
  CONSTRAINT uq_insight_versions_insight_id_version_no UNIQUE (insight_id, version_no)
);
--> statement-breakpoint
CREATE INDEX idx_insight_versions_workspace_insight_version
  ON insight_versions(workspace_id, insight_id, version_no DESC);
--> statement-breakpoint
-- One published version per refresh run, so a retry can't publish twice.
CREATE UNIQUE INDEX uq_insight_versions_routine_source_run_id
  ON insight_versions(source_run_id)
  WHERE source_run_id IS NOT NULL AND trigger = 'routine';
--> statement-breakpoint
CREATE INDEX idx_insight_versions_source_run_id
  ON insight_versions(source_run_id)
  WHERE source_run_id IS NOT NULL;
--> statement-breakpoint
-- A refresh run's unpublished edits. The run publishes the draft once, when it
-- succeeds; deleting the run cascades a leftover draft away.
CREATE TABLE insight_run_drafts (
  run_id          UUID PRIMARY KEY REFERENCES ai_workforce_queue(id) ON DELETE CASCADE,
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  insight_id      UUID NOT NULL REFERENCES insights(id) ON DELETE CASCADE,
  -- The version the draft was seeded from, to label a refresh that landed
  -- over a mid-run edit.
  base_version_no INTEGER NOT NULL,
  html            TEXT NOT NULL,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX idx_insight_run_drafts_insight_id ON insight_run_drafts(insight_id);
--> statement-breakpoint
-- A routine can refresh one insight; at most one active refresh routine per
-- insight.
ALTER TABLE routines ADD COLUMN insight_id UUID REFERENCES insights(id) ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX idx_routines_insight_id ON routines(insight_id);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_routines_active_insight ON routines(insight_id)
  WHERE insight_id IS NOT NULL AND archived_at IS NULL;
--> statement-breakpoint
-- Why the system (not a person) paused a routine. Rebinding the insight
-- resumes only routines with a reason, so a manual pause is never undone.
ALTER TABLE routines ADD COLUMN paused_reason TEXT;
--> statement-breakpoint
ALTER TABLE routines ADD COLUMN paused_at TIMESTAMP WITH TIME ZONE;
--> statement-breakpoint
ALTER TABLE routines ADD CONSTRAINT chk_routines_paused_reason
  CHECK (paused_reason IS NULL OR paused_reason IN ('agent_deprecated', 'agent_incompatible'));
--> statement-breakpoint
-- Deleting an insight cascades to its routine; keep the run history and drop
-- only the routine attribution.
ALTER TABLE ai_workforce_queue DROP CONSTRAINT IF EXISTS ai_workforce_queue_origin_routine_id_fkey;
--> statement-breakpoint
ALTER TABLE ai_workforce_queue ADD CONSTRAINT ai_workforce_queue_origin_routine_id_fkey
  FOREIGN KEY (origin_routine_id) REFERENCES routines(id) ON DELETE SET NULL;
--> statement-breakpoint
-- The HITL intervention a run is paused on:
-- { tool_name, tool_args, asked_user_id, asked_at }. Cleared when a decision
-- queues the resume.
ALTER TABLE ai_workforce_queue ADD COLUMN pending_intervention JSONB;
--> statement-breakpoint
-- An insight's failed refresh runs. The insight id is in trigger_meta, or only
-- in input on a retried run, so both get an index.
CREATE INDEX idx_ai_workforce_queue_refresh_trigger_meta_insight
  ON ai_workforce_queue(workspace_id, (trigger_meta->>'insight_id'))
  WHERE origin_routine_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX idx_ai_workforce_queue_refresh_input_insight
  ON ai_workforce_queue(workspace_id, (input->>'insight_id'))
  WHERE origin_routine_id IS NOT NULL;
