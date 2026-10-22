# Personal tasks (to-dos with reminders)

A Todoist-style personal to-do list. Each task is a title plus an optional
reminder time; it belongs to one user in one workspace and nobody else can see it.

## Where it shows up

- **Profile → items tab → "Needs your attention"** — the list sits above the
  vote / approval cards. The section badge counts open tasks plus action items.
- **Sidebar footer tasks button** (desktop), next to the "what's new" bell. Opens
  the same list in a popover; a red count marks overdue reminders. Its "View
  all" opens the page below.
- **`/tasks`, "Your tasks"** (`src/views/Tasks.tsx`): the list as a full page
  under the shared `PageHeader`, with a red *N overdue* badge beside the title.
  On mobile it is pinned on the bot home beside Timeline — a glass tile whose
  icon turns red and wears a red count when a reminder has passed — and the
  shell floats the back button over it like every other mobile page.

All three are `TaskList` (`src/components/tasks/`) over one react-query cache
(`useUserTasks`), so an edit in one appears in the others at once. Mutations are
optimistic and roll back with a toast on failure.

## The bots manage them too

Every Copilot bot has the `tasks` skill (`src/lib/bots/skills.ts`): `list_tasks`
(open tasks with reminders, overdue ones flagged, and the current time so a
relative reminder can be worked out; completed ones on request), `create_task`
(title plus an optional ISO reminder), `update_task` (rename, re-time or clear
the reminder, complete or reopen) and `delete_task`. All four act for the
chatting user (`configurable.userId`) through `UserTaskService`, the same path
the API takes, and **apply at once: no approval card and no Workforce hand-off** —
a to-do is the user's own note, not a job. A task is named by id or by title; a
phrase that matches more than one task is refused rather than guessed
(`resolveTaskRef` in `tools/taskRef.ts`). The fixed instructions say so to every
bot, and that only long-running work (building an insight) goes to the Workforce.

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
