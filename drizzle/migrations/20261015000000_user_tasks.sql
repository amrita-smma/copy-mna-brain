-- Personal to-dos behind Profile → "Needs your attention" and the sidebar
-- tasks button. A task belongs to one user in one workspace; nobody else can
-- read it.
--
-- `remind_at` is optional. When it passes, `/api/cron/task-reminders` emails
-- the owner once and stamps `reminder_sent_at` so the sweep never repeats
-- itself. Moving `remind_at` clears the stamp so the new time fires again.
CREATE TABLE IF NOT EXISTS user_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  remind_at timestamptz,
  reminder_sent_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- The owner's list: open tasks first, then completed.
CREATE INDEX IF NOT EXISTS idx_user_tasks_owner
  ON user_tasks (workspace_id, user_id, completed_at, created_at);

-- The reminder sweep only ever looks at open, unsent, scheduled tasks.
CREATE INDEX IF NOT EXISTS idx_user_tasks_due_reminders
  ON user_tasks (workspace_id, remind_at)
  WHERE completed_at IS NULL AND reminder_sent_at IS NULL AND remind_at IS NOT NULL;
