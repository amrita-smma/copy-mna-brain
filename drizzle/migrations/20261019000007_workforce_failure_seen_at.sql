-- When the owner of a failed AI Workforce run first opened it. NULL on a
-- failed run means "unseen" — the red count on the Workforce nav item.
ALTER TABLE ai_workforce_queue
  ADD COLUMN IF NOT EXISTS failure_seen_at timestamp with time zone;

-- Failures that predate the column count as seen, so nobody's nav lights up
-- with every failure in the workspace's history on deploy.
UPDATE ai_workforce_queue
  SET failure_seen_at = COALESCE(ended_at, now())
  WHERE status IN ('failed', 'timed_out') AND failure_seen_at IS NULL;

-- The nav summary counts one user's unseen failures per workspace.
CREATE INDEX IF NOT EXISTS idx_ai_workforce_queue_unseen_failures
  ON ai_workforce_queue USING btree (workspace_id, triggered_by_user_id)
  WHERE status IN ('failed', 'timed_out') AND failure_seen_at IS NULL;
