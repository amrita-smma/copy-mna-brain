-- contact_relationship_overviews
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'contact_relationship_overview';

CREATE TABLE IF NOT EXISTS contact_relationship_overviews (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  correspondent_id uuid NOT NULL REFERENCES correspondents(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'failed')),
  overview text,                -- last successful text; kept while a regeneration is pending/failed
  -- [{ "companyId": uuid, "note": text }]: one line per linked deal on what the
  -- contact did on it, written with `overview`; deals with no evidence are absent.
  deal_notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- One sentence, across the contact's emails, on what they do in investments
  -- with us (the Role in investment line); written with `overview`.
  role_summary text,
  input_hash text,              -- hash of the inputs the current `overview` was built from
  job_id uuid,
  generated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, correspondent_id)
);
