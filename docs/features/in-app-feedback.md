# In-app feedback (MB-480)

Every workspace sidebar has a **Send Feedback** button (`FeedbackDialog`, in
the `SidebarFooter` next to Sign Out) so users can report issues or ideas
without pinging a developer directly.

- `POST /api/feedback` (`{ title, message }`) is the only entry point. It
  requires an authenticated session and resolves the active workspace via
  `getActiveWorkspaceIdOrThrow()` (write-endpoint fail-closed; returns 403 when
  none is active), then calls `FeedbackService.submit`.
- `FeedbackService.submit` always stores the row first
  (`FeedbackRepository.create` → `feedback` table: `workspace_id`, `user_id`,
  `title`, `message`, `jira_issue_key`, `created_at`) — that write is the one
  thing that must never be lost. It then best-effort files a Jira ticket
  (`src/lib/jira.ts`, `createJiraIssue`, project key from `JIRA_PROJECT_KEY`,
  default `MB`, summary = the feedback title) and stamps the returned key back
  onto the row, and best-effort emails `nico.alimin@smma.id`
  (`EmailService.sendFeedbackSubmittedEmail`, subject
  `{workspace name} - New Feedback from {user name} Received`) with the submitter,
  workspace, title, message, and Jira link when one exists. Both side effects
  are wrapped in their own try/catch and only logged on failure — a down Jira
  instance or SES outage never causes the user's submission to fail.
- Jira is optional per-environment: `isJiraConfigured()` gates the attempt on
  `JIRA_BASE_URL` + `JIRA_EMAIL` + `JIRA_API_TOKEN` being set (see
  `.env.example`); when unset, feedback still saves and still emails, just
  without a ticket.
