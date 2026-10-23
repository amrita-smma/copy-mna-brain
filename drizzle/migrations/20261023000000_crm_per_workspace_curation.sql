-- MB-687: CRM editing is per workspace.
--
-- The firm (employers) and the person (correspondents) stay shared rows owned
-- by the ingest. Everything a human or the @crm_contact agent sets on top of
-- them becomes per workspace, so one workspace's edits never show in another:
--
--   correspondent_curation   contact profile edits      → (workspace_id, correspondent_id)
--   employer_curation        firm name/industry + PIC   → (workspace_id, employer_id)
--   employer_team_members    team assignee              → (workspace_id, employer_id, user_id)
--   employer_topics          topic tags                 → (workspace_id, employer_id, topic_id)
--
-- Reads go through two new views that lay one workspace's edits over the
-- shared row: correspondent_workspace_effective (which also carries the
-- workspace's visibility, from workspace_correspondents) and
-- employer_workspace_effective. The old global views keep their columns but
-- drop the overlay: a global view cannot know which workspace's edit to show.
--
-- Backfill: every existing overlay/team/tag row is copied into each workspace
-- that can see the firm or contact today, so nobody loses an edit.
--
-- Also: firm notes get edit/delete auditing (employer_note_revisions) and a
-- soft delete, so the history outlives the note.

-- Workspaces that can see each firm, by the CRM list's own rule
-- (EmployerRepository.buildWhere): a visible contact at it, a live related-
-- company link, a firm note, or one of the workspace's private topics on it.
-- Copying to exactly these workspaces means a firm's edits, tags and team land
-- where its card already shows — never in a workspace that could not see it.
CREATE TEMP TABLE _employer_ws AS
SELECT wc.workspace_id, co.employer_id
FROM workspace_correspondents wc
JOIN correspondents co ON co.id = wc.correspondent_id
UNION
SELECT rc.workspace_id, rc.employer_id
FROM employer_related_companies rc
WHERE rc.dismissed_at IS NULL
UNION
SELECT n.workspace_id, n.employer_id
FROM employer_notes n
UNION
SELECT t.workspace_id, et.employer_id
FROM employer_topics et
JOIN topics t ON t.id = et.topic_id
WHERE t.workspace_id IS NOT NULL;

-- ── correspondent_curation ──────────────────────────────────────────────────
-- The old key must go first: each copy reuses the same correspondent_id.
ALTER TABLE correspondent_curation ADD COLUMN workspace_id uuid;
ALTER TABLE correspondent_curation DROP CONSTRAINT correspondent_curation_pkey;

INSERT INTO correspondent_curation (
  workspace_id, correspondent_id, name, title, phone, type, edited_by, edited_at,
  department, specialization, seniority, coverage_region, linkedin_url, bio
)
SELECT
  wc.workspace_id, cc.correspondent_id, cc.name, cc.title, cc.phone, cc.type,
  cc.edited_by, cc.edited_at, cc.department, cc.specialization, cc.seniority,
  cc.coverage_region, cc.linkedin_url, cc.bio
FROM correspondent_curation cc
JOIN workspace_correspondents wc ON wc.correspondent_id = cc.correspondent_id
WHERE cc.workspace_id IS NULL;

DELETE FROM correspondent_curation WHERE workspace_id IS NULL;
ALTER TABLE correspondent_curation
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT correspondent_curation_pkey PRIMARY KEY (workspace_id, correspondent_id),
  ADD CONSTRAINT correspondent_curation_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
CREATE INDEX idx_correspondent_curation_correspondent
  ON correspondent_curation (correspondent_id);

-- ── employer_curation (+ the workspace's chosen primary contact) ────────────
ALTER TABLE employer_curation
  ADD COLUMN workspace_id uuid,
  ADD COLUMN primary_correspondent_id uuid;
ALTER TABLE employer_curation DROP CONSTRAINT employer_curation_pkey;

INSERT INTO employer_curation (workspace_id, employer_id, name, industry, edited_by, edited_at)
SELECT ew.workspace_id, ec.employer_id, ec.name, ec.industry, ec.edited_by, ec.edited_at
FROM employer_curation ec
JOIN _employer_ws ew ON ew.employer_id = ec.employer_id
WHERE ec.workspace_id IS NULL;

DELETE FROM employer_curation WHERE workspace_id IS NULL;
ALTER TABLE employer_curation
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT employer_curation_pkey PRIMARY KEY (workspace_id, employer_id),
  ADD CONSTRAINT employer_curation_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD CONSTRAINT employer_curation_primary_correspondent_id_fkey
    FOREIGN KEY (primary_correspondent_id) REFERENCES correspondents(id) ON DELETE SET NULL;
CREATE INDEX idx_employer_curation_employer ON employer_curation (employer_id);

-- ── employer_team_members ───────────────────────────────────────────────────
-- A member is kept in each workspace they belong to that can see the firm. A
-- member of none of them (an ex-member, or a seed user) is kept in every
-- workspace that can see the firm, which is exactly what those see today.
ALTER TABLE employer_team_members ADD COLUMN workspace_id uuid;
ALTER TABLE employer_team_members DROP CONSTRAINT employer_team_members_pkey;

INSERT INTO employer_team_members (workspace_id, employer_id, user_id, created_at)
SELECT DISTINCT ew.workspace_id, tm.employer_id, tm.user_id, tm.created_at
FROM employer_team_members tm
JOIN _employer_ws ew ON ew.employer_id = tm.employer_id
WHERE tm.workspace_id IS NULL
  AND (
    EXISTS (
      SELECT 1 FROM user_workspaces uw
      WHERE uw.user_id = tm.user_id AND uw.workspace_id = ew.workspace_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM _employer_ws ew2
      JOIN user_workspaces uw2
        ON uw2.workspace_id = ew2.workspace_id AND uw2.user_id = tm.user_id
      WHERE ew2.employer_id = tm.employer_id
    )
  );

DELETE FROM employer_team_members WHERE workspace_id IS NULL;
ALTER TABLE employer_team_members
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT employer_team_members_pkey PRIMARY KEY (workspace_id, employer_id, user_id),
  ADD CONSTRAINT employer_team_members_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- ── employer_topics ─────────────────────────────────────────────────────────
-- A workspace-private topic stays with its own workspace; a shared-vocabulary
-- tag is copied into every workspace that can see the firm.
ALTER TABLE employer_topics ADD COLUMN workspace_id uuid;
DROP INDEX IF EXISTS uq_employer_topic;

INSERT INTO employer_topics (workspace_id, employer_id, topic_id, source, is_highlight, created_at)
SELECT DISTINCT ON (ws.workspace_id, et.employer_id, et.topic_id)
  ws.workspace_id, et.employer_id, et.topic_id, et.source, et.is_highlight, et.created_at
FROM employer_topics et
JOIN topics t ON t.id = et.topic_id
JOIN LATERAL (
  SELECT t.workspace_id WHERE t.workspace_id IS NOT NULL
  UNION
  SELECT ew.workspace_id FROM _employer_ws ew
  WHERE t.workspace_id IS NULL AND ew.employer_id = et.employer_id
) ws ON true
WHERE et.workspace_id IS NULL;

DELETE FROM employer_topics WHERE workspace_id IS NULL;
ALTER TABLE employer_topics
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT employer_topics_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX uq_employer_topic
  ON employer_topics (workspace_id, employer_id, topic_id);

DROP TABLE _employer_ws;

-- ── Views ───────────────────────────────────────────────────────────────────
-- Global views keep their exact column lists (CREATE OR REPLACE cannot drop or
-- reorder columns) but no longer apply the overlay. Only matching by key
-- (normalized_name, email) and the analytics dims still read them.
CREATE OR REPLACE VIEW employer_effective
  WITH (security_invoker = on) AS
SELECT
  e.id,
  e.name,
  e.industry,
  e.normalized_name,
  e.status,
  e.curation_status,
  e.created_at,
  e.updated_at
FROM employers e;

CREATE OR REPLACE VIEW correspondent_effective
  WITH (security_invoker = on) AS
SELECT
  co.id,
  co.employer_id,
  co.name,
  co.title,
  co.email,
  co.phone,
  co.type,
  co.is_primary,
  co.source,
  co.origin,
  co.last_edited_by_user_id,
  co.last_edited_at,
  co.created_at,
  co.updated_at,
  co.department,
  co.specialization,
  co.seniority,
  co.coverage_region,
  co.linkedin_url,
  co.bio
FROM correspondents co;

-- One row per (workspace, firm). Filter on workspace_id; the cross join is
-- collapsed to that one workspace by the planner.
CREATE VIEW employer_workspace_effective
  WITH (security_invoker = on) AS
SELECT
  w.id AS workspace_id,
  e.id,
  COALESCE(c.name,     e.name)     AS name,
  COALESCE(c.industry, e.industry) AS industry,
  e.normalized_name,               -- always the MACHINE name (merge key); never overridden
  e.status,
  e.curation_status,
  e.created_at,
  e.updated_at,
  c.primary_correspondent_id
FROM employers e
CROSS JOIN workspaces w
LEFT JOIN employer_curation c
  ON c.employer_id = e.id AND c.workspace_id = w.id;

-- One row per contact VISIBLE in a workspace (the workspace_correspondents
-- join is the visibility rule). `is_primary` is true only for the contact the
-- workspace picked; callers fall back to the oldest when none is picked.
CREATE VIEW correspondent_workspace_effective
  WITH (security_invoker = on) AS
SELECT
  wc.workspace_id,
  co.id,
  co.employer_id,
  COALESCE(cc.name,  co.name)  AS name,
  COALESCE(cc.title, co.title) AS title,
  co.email,                        -- natural key; machine-owned
  COALESCE(cc.phone, co.phone) AS phone,
  COALESCE(cc.type,  co.type)  AS type,
  (ec.primary_correspondent_id IS NOT NULL AND ec.primary_correspondent_id = co.id) AS is_primary,
  co.source,
  co.origin,
  co.last_edited_by_user_id,
  co.last_edited_at,
  co.created_at,
  co.updated_at,
  COALESCE(cc.department,      co.department)      AS department,
  COALESCE(cc.specialization,  co.specialization)  AS specialization,
  COALESCE(cc.seniority,       co.seniority)       AS seniority,
  COALESCE(cc.coverage_region, co.coverage_region) AS coverage_region,
  COALESCE(cc.linkedin_url,    co.linkedin_url)    AS linkedin_url,
  COALESCE(cc.bio,             co.bio)             AS bio
FROM workspace_correspondents wc
JOIN correspondents co ON co.id = wc.correspondent_id
LEFT JOIN correspondent_curation cc
  ON cc.correspondent_id = co.id AND cc.workspace_id = wc.workspace_id
LEFT JOIN employer_curation ec
  ON ec.employer_id = co.employer_id AND ec.workspace_id = wc.workspace_id;

-- ── Firm notes: audited edit/delete ─────────────────────────────────────────
ALTER TABLE employer_notes
  ADD COLUMN updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE employer_note_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  note_id uuid NOT NULL,
  action text NOT NULL,
  content_before text,
  content_after text,
  changed_by uuid,
  changed_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT employer_note_revisions_note_id_fkey
    FOREIGN KEY (note_id) REFERENCES employer_notes(id) ON DELETE CASCADE,
  CONSTRAINT employer_note_revisions_changed_by_fkey
    FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT employer_note_revisions_action_check
    CHECK (action IN ('create', 'edit', 'delete'))
);
CREATE INDEX idx_employer_note_revisions_note_changed
  ON employer_note_revisions (note_id, changed_at);

ALTER TABLE employer_note_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow read access on employer_note_revisions"
  ON employer_note_revisions AS PERMISSIVE FOR SELECT TO public USING (true);
CREATE POLICY "Allow insert access on employer_note_revisions"
  ON employer_note_revisions AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);
