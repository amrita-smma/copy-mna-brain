-- Migration: CRM workspace scoping (MB-337 follow-up) — topics.
-- Created: 2026-07-05
--
-- Splits one shared "topics" table into two roles it plays today:
--   - workspace_id IS NULL: the shared classification vocabulary the LLM
--     enrichment detects (e.g. "M&A", "ECM"). Untouched — crmIngest keeps
--     resolving/creating these exactly as before.
--   - workspace_id IS NOT NULL: a workspace's own private topic name.
-- No backfill needed: every existing row is correctly a shared-vocabulary
-- row and stays NULL.
--
-- employer_topics gets no column of its own — a tag's workspace scope is
-- inherited from its topic_id's workspace_id (derived-through-parent, same
-- principle as track_variables/criterias deriving through investment_thesis).
ALTER TABLE topics ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id);
CREATE INDEX IF NOT EXISTS idx_topics_workspace_id ON topics(workspace_id);

-- Global uniqueness now only applies within the shared vocabulary (NULL);
-- private topics are unique per workspace instead of globally.
ALTER TABLE topics DROP CONSTRAINT IF EXISTS topics_name_key;
ALTER TABLE topics DROP CONSTRAINT IF EXISTS topics_slug_key;

CREATE UNIQUE INDEX IF NOT EXISTS topics_name_global_key ON topics(name) WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS topics_name_workspace_key ON topics(workspace_id, name) WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS topics_slug_global_key ON topics(slug) WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS topics_slug_workspace_key ON topics(workspace_id, slug) WHERE workspace_id IS NOT NULL;
