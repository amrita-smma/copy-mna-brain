-- Add human_decisions column to ai_workforce_queue.
--
-- Records the resolution of HITL (human-in-the-loop) interrupts raised by
-- langchain's humanInTheLoopMiddleware. Each entry corresponds to one tool
-- call that the user reviewed.
--
-- We use a JSONB array rather than a separate table because:
--   1. Decisions are task-scoped (always read together with the task row).
--   2. Cardinality is low (most tasks have 0; HITL tasks have 1-3).
--   3. No cross-task analytics planned. Only the task creator can decide
--      (enforced at the API layer via triggered_by_user_id), so we don't
--      need a decided_by column or a join.
--   4. Matches the existing pattern on this table (input, output,
--      trigger_meta, error are all JSONB).
--
-- Element shape (see HumanDecision in src/lib/db/schema.ts):
--   {
--     tool_call_id: string,       // matches the AIMessage.tool_calls[].id
--     tool_name: string,
--     decision: "approve" | "edit" | "reject",
--     edited_args?: object,       // present only when decision === "edit"
--     rejection_message?: string, // present only when decision === "reject"
--     decided_at: string          // ISO 8601 UTC
--   }
--
-- Append-only at the application layer. No DB-side constraint enforces that;
-- the repository is the gatekeeper.

ALTER TABLE ai_workforce_queue
  ADD COLUMN human_decisions jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN ai_workforce_queue.human_decisions IS
  'Audit log of HITL decisions for this run. Append-only JSONB array; see HumanDecision in schema.ts for element shape.';
