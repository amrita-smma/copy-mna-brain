-- pending_auto_scan_settings
-- Sourcing → Pending Confirmation automation toggles (workspace-wide) and the
-- job type that runs the match → screen → drop/promote pass.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS pending_auto_scan boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pending_auto_drop_promote boolean NOT NULL DEFAULT false;

ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'pending_auto_scan';

-- Per-company queue mark drained by /api/cron/pending-auto-scan.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS auto_scan_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_scan_force boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_companies_auto_scan_requested_at
  ON companies USING btree (auto_scan_requested_at)
  WHERE auto_scan_requested_at IS NOT NULL;
