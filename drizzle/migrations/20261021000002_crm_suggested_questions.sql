-- crm_suggested_questions
-- "Ask Brain" suggested questions for the CRM page (MB-862): one row per
-- (workspace, user, day). Written by the daily cron and on demand when a user
-- opens the CRM before the cron ran. `questions` is the generated list
-- ({ personalized, generic, hasSync }); it is built from templates filled with
-- the user's own interaction data, never another user's. See
-- docs/features/crm-banker-insights.md#ask-brain.
CREATE TABLE IF NOT EXISTS crm_suggested_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The Asia/Jakarta calendar day the questions are for.
  for_date date NOT NULL,
  questions jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_crm_suggested_questions_workspace_user_date
    UNIQUE (workspace_id, user_id, for_date)
);
