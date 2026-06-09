-- vault_exports: tracks in-flight and completed Vault exports.
-- One row per export window. The Poll Lambda processes rows where
-- status = 'exporting'.
CREATE TABLE IF NOT EXISTS analytics.vault_exports (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  matter_id        TEXT        NOT NULL,
  export_id        TEXT        NOT NULL,
  custodian_emails TEXT[]      NOT NULL,
  window_start     TIMESTAMPTZ NOT NULL,
  window_end       TIMESTAMPTZ NOT NULL,
  mode             TEXT        NOT NULL,  -- 'daily' | 'monthly'
  status           TEXT        NOT NULL DEFAULT 'exporting',
  -- status values: 'exporting' | 'completed' | 'failed' | 'archived'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vault_exports_status
  ON analytics.vault_exports (status);
