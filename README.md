## Getting started

## Install Vercel CLI

```bash
npm i -g vercel
```

## Pull environment variables

Local development reads from `.env.vercel` (gitignored). Link the project and pull the latest values from Vercel:

```bash
vercel link
vercel env pull .env.vercel
```

Re-run `vercel env pull .env.vercel` whenever environment variables change in the Vercel dashboard.

## Run the dev server

> **Important:** Use `vercel dev` instead of `pnpm run dev`. This ensures environment variables and Vercel-specific features (edge config, feature flags, etc.) are available locally.

```bash
vercel dev
```

## End-to-end tests

E2E tests live in `./e2e` and run with [Playwright](https://playwright.dev) against a Next.js dev server. `playwright.config.ts` launches `vercel dev` automatically and reuses an existing server if one is already running on `http://localhost:3000`.

### First-time setup

Install the Playwright browser binaries once per machine:

```bash
pnpm exec playwright install
```

### Run the tests

```bash
# all tests, headless
pnpm test:e2e

# interactive UI mode (watch, re-run, time-travel)
pnpm test:e2e:ui

# a specific spec file
pnpm exec playwright test e2e/dashboard.spec.ts

# a single test by name
pnpm exec playwright test -g "paginates at 10 items per page"

# headed / debug
pnpm exec playwright test --headed
pnpm exec playwright test --debug
```

### View the report

After a run, open the HTML report:

```bash
pnpm exec playwright show-report
```

## Unit tests

Unit tests for backend code under `src/lib` use [Vitest](https://vitest.dev). Files
colocated next to the code they cover with a `.test.ts` suffix.

```bash
pnpm test          # run once
pnpm test:watch    # watch mode
```

## CRM (Contact Relationship Management)

The CRM module manages contacts and their communication history.

### Database Tables

- **contacts** — Stores contact information (name, email, phone, company, title, type)
- **contact_messages** — Stores communication history linked to contacts

### Features

- Contact management (create, update, delete, search)
- Communication history per contact
- Integration with AI File Dump for banker communications

### Banker Communications

The AI File Dump supports a "banker_communications" file type for CSV and MBOX exports (e.g., from Google Vault). When uploaded:

1. The File Processing Agent detects email communications
2. Contacts are automatically created or matched by email
3. Messages are linked to contacts in the CRM

### API Endpoints

- `GET /api/crm` — List all contacts (supports `?q=` query)
- `POST /api/crm` — Create a new contact
- `GET /api/crm/:id` — Get contact with messages
- `PATCH /api/crm/:id` — Update contact
- `DELETE /api/crm/:id` — Delete contact
- `GET /api/crm/:id/messages` — Get contact's messages
- `POST /api/crm/:id/messages` — Add message to contact

## Forgot-password flow (AWS SES + Vercel Queues)

Password resets are delivered out-of-band by email — the `/api/auth/forget-password`
endpoint never echoes the token in its response.

End-to-end shape:

1. User submits their email at `/reset-password`. The page POSTs to
   `/api/auth/forget-password`, which always returns `{ ok: true }` whether or
   not the email is registered (anti-enumeration).
2. `AuthService.forgetPassword` looks up the user. If found, it persists a
   random token in `reset_password_tokens` (1h TTL) and publishes a message
   to the `send-email` topic via [Vercel Queues](https://vercel.com/docs/queues)
   (`enqueueSendEmail` in `src/lib/queue.ts`).
3. Vercel pushes the message to the consumer route at
   `/api/queues/send-email/route.ts` — declared via `experimentalTriggers` in
   `vercel.json`, which makes the route private (no public URL on Vercel).
   The route delegates to `runSendEmail`, which renders the email body via
   `EmailService` and calls `src/lib/ses.ts → sendEmail` (AWS SES v2
   `SendEmailCommand`).
4. The email contains a link to `/reset-password?token=<token>`. The page
   detects the `token` query param and shows the "choose a new password"
   form, which POSTs to `/api/auth/reset-password` and finishes the flow.

Why Vercel Queues (not the in-house `jobs` table) for email: the email path
is a one-shot, low-latency, fire-and-forget call where the queue's
at-least-once delivery, automatic retries with backoff (configured in the
consumer's `retry` callback), and visibility-timeout extension are exactly
what we want — and we don't need the `job_logs` audit trail or domain-table
foreign keys that justify the `jobs` table for AI screening / analysis. SES
failures retry transparently; after 5 deliveries the message is
acknowledged so a poison payload can't block the queue.

The publish is wrapped in a try/catch in `AuthService.forgetPassword`: a
queue outage is logged but does not surface as an error response, otherwise
the failure mode would leak whether the email was registered.

### Configuration

App env (`.env`): `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SES_REGION`
(defaults to `AWS_REGION`), `SES_FROM_EMAIL`, optional `SES_REPLY_TO`, and
`NEXT_PUBLIC_APP_URL` (used to build the reset link inside the email body).
The default `SES_FROM_EMAIL` is a placeholder — override it with a verified
SES identity for actual delivery.

Vercel Queues auth: on Vercel deployments authentication is automatic via
[OIDC](https://vercel.com/docs/oidc). For local development run
`vercel link && vercel env pull .env.vercel` once to populate `.env.vercel`
with the OIDC tokens the SDK needs to publish to the queue. Without those,
calls to `enqueueSendEmail` will fail and the catch block in
`AuthService.forgetPassword` will swallow the error (which preserves the
user-facing flow but means no email is sent locally — fine for dev).

## Async jobs

Long-running compute (AI screening, company analysis, market screening,
slide generation) is dispatched via `JobDispatcher`/`dispatchJob`, which
inserts a row into the `jobs` table and schedules the work via Next.js
`after()`. The runner transitions the row through
`pending → running → completed | failed | timed_out`, and every state change
is appended to `job_logs`. Transactional email is the one async path that
runs through Vercel Queues instead — see the forgot-password section above
for the rationale.

### Stuck-job cleanup scheduler

If a request is aborted before `after()` fires, a job can get stuck in `pending`
forever; if the runner process crashes mid-work, a job can get stuck in
`running`. A background sweep (`JobService.cleanupStuckJobs`) transitions any
`pending` or `running` rows whose age exceeds `timeout_seconds + buffer` into
`timed_out`, writing a `job_logs` entry that records the forced transition.

The sweep runs in-process via `src/lib/jobs/scheduler.ts`. `setInterval` isn't
viable on serverless (the function freezes between requests), so the scheduler
is triggered by two request-adjacent hooks:

1. **Cold start** — `src/instrumentation.ts` fires `runSchedulerIfDue` once per
   Node runtime init. Fire-and-forget so cold-start latency is unaffected.
2. **Job dispatch** — `dispatchJob` schedules a second `after()` that calls
   the same function. Guarantees the sweep runs even if cold starts are rare.

Every trigger is gated by a 24h DB window: `runSchedulerIfDue` queries the
most recent `stuck_cleanup` job row and skips if one was created within the
last 24h. Each sweep that actually runs is itself inserted as a
`stuck_cleanup` job, producing standard `job_logs` transitions
(`pending → running → completed`) for observability. A per-process
`inFlight` promise coalesces concurrent triggers.

Trade-offs:

- If the deployment has no cold starts and no job dispatches for 24h, no sweep
  runs. That's fine: no activity ⇒ no new stuck jobs.
- Multi-instance deployments can race — two cold starts within a few ms of
  each other could both see "no recent sweep" and both dispatch. Cleanup is
  idempotent, so at worst two sweeps run in the same window.

There's also a manual trigger at `GET /api/cron/cleanup-jobs` (useful for ops
or incident response). Pass `?force=true` to bypass the 24h window. Protect
it by setting `CRON_SECRET` and sending `Authorization: Bearer $CRON_SECRET`.

```bash
# respects the 24h window
curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/cleanup-jobs
# force an immediate sweep
curl -H "Authorization: Bearer $CRON_SECRET" "https://<host>/api/cron/cleanup-jobs?force=true"
```
