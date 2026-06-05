-- Add pending_user_messages column to ai_workforce_queue.
--
-- Buffer of free-form user messages submitted via the TaskCanvas composer
-- while a workforce run is paused / queued. Consumed FIFO by runAgent on
-- the next claim (or by graph.resume mid-thread for a waiting row).
--
-- This mirrors the existing human_decisions design (jsonb array on the row
-- itself) because:
--   1. Messages are task-scoped (always read together with the task row).
--   2. Cardinality is low (most paused tasks get 0-3 user updates).
--   3. No cross-task analytics planned.
--   4. Matches the existing pattern on this table.
--
-- Element shape (see PendingUserMessage in src/lib/db/schema.ts):
--   {
--     id: string,                   // uuid generated client-side at append
--     text: string,                 // user-provided update text
--     submitted_at: string,         // ISO 8601 UTC
--     submitted_by_user_id: string  // who typed the message
--   }
--
-- Append-only at the application layer; consumed atomically by the agent
-- (read + clear in one transaction).

ALTER TABLE ai_workforce_queue
  ADD COLUMN pending_user_messages jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN ai_workforce_queue.pending_user_messages IS
  'FIFO buffer of user-supplied update messages submitted via TaskCanvas. Consumed by runAgent on next invoke/resume.';
