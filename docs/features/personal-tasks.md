# Personal tasks (to-dos with reminders)

A Todoist-style personal to-do list. Each task is a title plus an optional
reminder time; it belongs to one user in one workspace and nobody else can see it.

## Where it shows up

- **Profile → items tab → "Needs your attention"** — the list sits above the
  vote / approval cards. The section badge counts open tasks plus action items.
- **Sidebar footer tasks button** (desktop), next to the "what's new" bell. Opens
  the same list in a popover; a red count marks overdue reminders.

Both are `TaskList` (`src/components/tasks/`) over one react-query cache
(`useUserTasks`), so an edit in one appears in the other at once. Mutations are
optimistic and roll back with a toast on failure.

## Data and API

`user_tasks` table → `UserTaskRepository` → `UserTaskService` →
`/api/tasks` (GET, POST) and `/api/tasks/[id]` (PATCH, DELETE). Every route takes
the user from the session; the repository filters on workspace **and** user, so a
foreign task id is a 404. The list returns all open tasks plus the 20 most
recently completed (open tasks are capped at 500 as a safety bound).

## Reminders

When `remind_at` passes on an open task, two independent things happen:

1. **Email.** `/api/cron/task-reminders` runs every minute (`vercel.json`),
   sweeps each workspace, atomically claims due tasks (one `UPDATE … WHERE
   reminder_sent_at IS NULL RETURNING`, so overlapping sweeps never double-send),
   and enqueues a `task_reminder` email through the `send-email` queue. If an
   enqueue fails, that task's claim is released and the next sweep retries it.
   Changing `remind_at` clears the stamp, so the new time fires again.
2. **In-app.** `TaskReminderAlerts`, mounted once in each `AppShell` branch,
   shows a toast and, if the browser granted permission, a system notification.
   Permission is requested the first time someone sets a reminder. Alerts that
   already fired are remembered in localStorage per `(task id, remind_at)`.

There is no Web Push: with the app closed, the reminder arrives by email only.
