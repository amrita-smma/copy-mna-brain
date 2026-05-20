-- Add retried_from_id column to ai_workforce_queue.
--
-- Links a retry attempt back to the original failed/cancelled row. When a user
-- clicks "Retry" on a terminal failed row, the API inserts a brand new pending
-- row (preserving agent_name, input, etc.) and sets retried_from_id to point
-- at the original. The original row stays untouched for debugging / audit.
--
-- Self-referential FK with ON DELETE SET NULL: deleting the original
-- shouldn't cascade-delete the retry chain (we want the retry's history to
-- survive even if the original is purged).

ALTER TABLE ai_workforce_queue
  ADD COLUMN retried_from_id uuid REFERENCES ai_workforce_queue(id) ON DELETE SET NULL;

CREATE INDEX idx_ai_workforce_queue_retried_from
  ON ai_workforce_queue (retried_from_id)
  WHERE retried_from_id IS NOT NULL;

COMMENT ON COLUMN ai_workforce_queue.retried_from_id IS
  'When set, this row is a user-initiated retry of the referenced original row. Original row stays terminal; the retry takes over execution.';
