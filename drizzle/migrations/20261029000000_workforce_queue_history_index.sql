-- workforce_queue_history_index
-- The AI Workforce rail's History list pages a workspace's finished runs
-- newest-finished first (keyset on finish time, then id), and the nav item's
-- red chip counts the workspace's failures that finished in the last 24 hours.
-- Both read COALESCE(ended_at, created_at) within one workspace.
CREATE INDEX IF NOT EXISTS idx_ai_workforce_queue_workspace_finished
  ON ai_workforce_queue USING btree (
    workspace_id,
    (COALESCE(ended_at, created_at)) DESC,
    id DESC
  );

-- The red chip no longer reads failure_seen_at, so its partial index has no
-- query left to serve. The column stays (see TECH_DEBT.md).
DROP INDEX IF EXISTS idx_ai_workforce_queue_unseen_failures;
