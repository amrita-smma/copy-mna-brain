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

## CRM data pipeline

The Google Vault MBOX archive + parse pipeline and the CRM ingest pipeline (enrichment, employer/correspondent resolution, analytics marts) live in the `analytics` Postgres schema and are documented in [`data-pipeline/README.md`](data-pipeline/README.md).

The app (`public` schema) overlays human curation on top of `analytics` mart data via `employer_effective` and `correspondent_effective` views. Cross-schema dependency is one-directional: `analytics` reads `public` effective views; nothing in `public` depends on `analytics`.

## Google SSO sign-in

Google is used for **authentication only** — a successful SSO flow proves the
caller owns the email, never grants access on its own. The user must already
exist in the `users` table; unknown emails are rejected with the message
*"Your user is not registered in the system, please contact the MnA team"*.
No account is ever auto-provisioned. After sign-in the session is the identical
NextAuth JWT a password login produces, so the rest of the app is unchanged.

Both entry points below verify the same Google-issued ID token server-side
(`AuthService.signInWithGoogleToken` → `verifyGoogleIdToken`,
`src/lib/services/googleToken.ts`, backed by `google-auth-library`), extract the
verified email, and look the user up by email.

### Login-page button (`/login`)

The primary entry point. `GoogleSignInButton`
(`src/components/GoogleSignInButton.tsx`) renders the Google Identity Services
"Sign in with Google" button using `NEXT_PUBLIC_GOOGLE_CLIENT_ID`. On success
Google hands the page an ID token (the GIS credential), and the login page:

1. POSTs the token to `POST /api/auth/google-signin` (public route). This
   verifies the token and confirms a local account exists, returning
   `{ data: { email } }`, or `403` with the exact "not registered" message, or
   `401` for an untrusted token. Its only job is to surface a precise,
   user-facing reason — the NextAuth provider collapses every failure into an
   opaque `CredentialsSignin` code.
2. On success calls `useAuth().signInWithGoogleToken(token)`, which triggers the
   `google-sso` Credentials provider in `src/auth.ts` to establish the session,
   then redirects to `/chat`.

The button is hidden when `NEXT_PUBLIC_GOOGLE_CLIENT_ID` is unset, leaving only
email/password sign-in.

### Dashboard token exchange (`/dashboard?token=eyJ...`)

The dashboard can also be opened with a Google ID token in the URL.
`GoogleSsoTokenGate` (`src/components/auth/GoogleSsoTokenGate.tsx`) wraps the
dashboard page: if a `token` query param is present it blocks rendering, calls
`useAuth().signInWithGoogleToken(token)` (same `google-sso` provider), then
strips `token` from the URL and renders the dashboard.

Set `GOOGLE_CLIENT_ID` (server) so the token's `aud` claim is enforced against
this app, and `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (browser) for the login button.
Signature, issuer, expiry and `email_verified` are always checked.

## External Chat API (`/api/v1/chat`)

Authorized external applications can talk to the same analysis agent that powers
the in-app Copilot, over a versioned, machine-to-machine API. Unlike the
cookie/session-authenticated in-app `/api/chat`, these endpoints authenticate
with an **API key** and expose a stable contract decoupled from the AI SDK's
internal message format.

### Authentication

Requests carry an API key as a bearer token, and must hold the `chat:write`
scope:

```
Authorization: Bearer mna_<secret>
```

Keys are minted out-of-band and the raw token is shown **once** — only a scrypt
hash (`src/lib/services/password.ts`) plus a short non-secret lookup prefix are
stored in the `api_keys` table. Verification (`ApiKeyService.verify`) looks up
non-revoked rows by prefix, then `timingSafeEqual`-compares the hash, checks the
required scope, and refreshes `last_used_at`. Revoke a key by setting
`revoked_at` (`ApiKeyService.revoke`).

Mint a key from the CLI:

```bash
pnpm tsx scripts/issue-api-key.ts "Acme Integration"            # default: chat:write
pnpm tsx scripts/issue-api-key.ts "Read-only bot" chat:read     # custom scopes
```

### Key management (`/api/auth/api-keys`)

Keys can also be managed over HTTP. These are **admin** endpoints, so they live
under `/api/auth/*` and are gated by the shared-secret `proxy.ts` middleware:
every request must carry an `X-Api-Secret` header matching the server's
`ADMIN_SECRET` env var (see [Admin routes](#admin-routes-apiauth) below). They
are **not** gated by a NextAuth session and **not** by a chat API key. Secrets
are never returned by read endpoints — the raw token is surfaced only once, in
the `POST` create response.

- `GET    /api/auth/api-keys`      — list all keys (metadata only)
- `POST   /api/auth/api-keys`      — mint a key; response `data` includes the raw `token` once
- `GET    /api/auth/api-keys/:id`  — fetch one key's metadata
- `PATCH  /api/auth/api-keys/:id`  — update `name` and/or `scopes`
- `DELETE /api/auth/api-keys/:id`  — revoke (soft delete via `revoked_at`)

```bash
# create
curl -X POST https://<host>/api/auth/api-keys \
  -H 'Content-Type: application/json' \
  -H "X-Api-Secret: $ADMIN_SECRET" \
  -d '{"name":"Acme Integration","scopes":["chat:write"]}'
# → { "data": { "id": "...", "name": "Acme Integration", "token": "mna_...", ... } }
```

### Endpoints

- `POST /api/v1/chat` — non-streaming; returns the assistant's full reply as JSON.
- `POST /api/v1/chat/stream` — streaming; emits Server-Sent Events.

Request body (identical for both):

```jsonc
{
  "conversation_id": "uuid",   // optional — omit to start a new conversation
  "messages": [
    { "role": "user", "content": "Compare ACME to our past acquisitions" }
  ]
}
```

When `conversation_id` is provided, only the latest user turn is sent to the
agent — prior state is rehydrated from the checkpointer by `thread_id`. When it
is omitted, a new conversation is created and the full `messages` array is used
as history (so stateless callers keep their context). The new id is returned in
the `X-Conversation-Id` header and in the response/`done` event.

Conversations are owned by the minting API key (`api_chat_conversations`,
scoped by `api_key_id`); a client can never read or resume another client's
conversation — an unowned id is indistinguishable from a missing one (404).

Non-streaming response:

```jsonc
{ "data": { "conversation_id": "uuid",
            "message": { "role": "assistant", "content": "...", "tool_calls": [] } } }
```

Streaming response is a documented SSE protocol (not the AI SDK's UIMessage
stream), so it is stable across `ai` SDK upgrades:

```
event: delta        data: {"text":"..."}
event: tool_call    data: {"name":"query_companies","args":{...}}
event: done         data: {"conversation_id":"uuid"}
event: error        data: {"code":"stream_error","message":"..."}
```

Layering follows the project's handler → service → repository convention:
`src/app/api/v1/chat/**` (handlers) → `ApiKeyService` / `ApiChatConversationService`
→ `ApiKeyRepository` / `ApiChatConversationRepository`, with shared HTTP glue in
`src/lib/server/apiChatSupport.ts`.

> **Not yet included:** per-key rate limiting. Add Vercel WAF rate rules or an
> Upstash-backed limiter before exposing this to untrusted clients.

## In-app Copilot chat caching

The in-app Copilot (`/api/chat` + `src/components/chat/ChatProvider.tsx`)
short-circuits repeated questions. On the **first turn of a new chat** the
client first asks whether the same question was already answered, and on a hit
renders the cached turn-1 **inline** as chat bubbles — the user's question, then
the cached AI answer wrapped in a dotted border (labelled *"Cached chat history
found on &lt;date&gt;"*) with two CTAs beneath it: **Continue from chat** or
**Start fresh** (`src/components/chat/CachedChatPreview.tsx`).

How it works:

- Each chat's first user message is recorded on the `copilot_chats` row as
  `first_user_message` plus `first_user_message_hash` — a SHA-256 of the
  **normalized** message (`trim` + lowercase + collapsed whitespace), indexed
  for lookup. Recording happens in `/api/chat` only for a brand-new chat (no
  `chat_id`), and only **after the run finishes** (a Next.js `after()` hook
  reads the persisted turn-1 once the response stream closes and records the
  key only when the assistant produced a complete, substantial answer). Partial,
  aborted, or errored runs are never cached; resumed threads never overwrite it.
- `POST /api/chat/cache-check` (`{ message }`) hashes the message via
  `CopilotChatsService.findCachedFirstTurn` and, on a **global** match (any
  user), reads the matched thread's turn-1 from the checkpointer
  (`AgentGraph.getMessages` → `extractFirstTurn`). It returns the cached
  question + answer only when that turn-1 produced a **substantial** answer —
  more than 6 words (`isCacheableResponse`); trivially short replies aren't
  worth reusing. Strictly turn-1: later turns carry context that could mislead a
  reused answer.
- **Continue from chat** forks rather than opening the source thread (which may
  belong to another user). `POST /api/copilot/chats/fork` (`{ sourceChatId }`)
  creates a new chat owned by the caller and seeds its agent thread with the
  cached turn-1 (`AgentGraph.seedMessages`), switches to it, and focuses the
  chat input so the user continues with that context in an isolated, owned
  conversation. **Start fresh** discards the preview and runs the agent normally.

Layering follows the handler → service → repository convention: the two new
route handlers delegate to `CopilotChatsService` (`recordFirstMessage`,
`findCachedFirstTurn`) → `CopilotChatsRepository` (`recordFirstMessage`,
`findLatestFirstMessageMatch`), with turn-1 extraction and checkpoint seeding in
the agent layer (`src/lib/agents/analysis`).

## Admin routes (`/api/auth`)

Privileged, machine-to-machine **admin** endpoints live under `/api/auth/*` and
are protected by a single shared secret rather than a user session or a chat API
key. The `proxy.ts` middleware (Next.js 16 middleware) intercepts the matched
admin routes and rejects any request whose `X-Api-Secret` header does not match
the server's `ADMIN_SECRET` env var:

```ts
// src/proxy.ts
export const config = {
  matcher: ["/api/auth/signup", "/api/auth/api-keys", "/api/auth/api-keys/:path*"],
};
```

Every admin request must therefore send:

```
X-Api-Secret: <ADMIN_SECRET>
```

`src/lib/api/client.ts` (`apiRequest`) attaches this header automatically from
`ADMIN_SECRET` for server-side internal calls. Current admin routes:

- `/api/auth/signup` — provision a user account
- `/api/auth/api-keys`, `/api/auth/api-keys/:id` — chat API key management (above)

**Adding a new admin route:** place it under `src/app/api/auth/<route>/`, and add
its path to the `matcher` array in `src/proxy.ts` so the `X-Api-Secret` gate
applies. Do not add a per-handler session check — auth happens in the middleware.

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
