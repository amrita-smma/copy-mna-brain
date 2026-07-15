-- Per-workspace feature-flag overrides. One row = one feature's on/off state
-- for one workspace. Absence of a row means "use the env/catalog default".
CREATE TABLE IF NOT EXISTS feature_flags (
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  feature_key   TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT feature_flags_pkey PRIMARY KEY (workspace_id, feature_key)
);

CREATE INDEX IF NOT EXISTS idx_feature_flags_workspace_id ON feature_flags (workspace_id);
