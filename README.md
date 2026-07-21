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

## AI File Dump

Uploaded files are processed by the File Processing Agent (`src/lib/agents/file_processing`), which classifies each document (prospectus, shopping_list, mom, banker_communications, financial_statement, legal_document, market_study, other) and extracts structured data.

### Multi-company auto-ingestion

Deal-target file types — **prospectus** and **shopping_list** — can describe multiple companies. The agent emits a `companies` array (one entry per target, each with identity fields, financials, and FX adjustments; `prospectus_summary` mirrors `companies[0]` for backward compatibility) and `FileService.processUpload` auto-ingests every extracted target directly on upload:

- **HITL review only for pipeline companies** — a target that fuzzy-matches an existing company actively in the L0–L5 pipeline is never auto-modified; the file is set to `awaiting_review` and the user approves the proposed changes through the review dialog (per-field/per-year selection via `FileService.approve`). Everything else is auto-accepted and the file completes immediately.
- **Pre-pipeline matches are auto-enriched** — a target matching an existing company outside the pipeline (`unreviewed`, `market_screening`, `discovered`) is enriched in place with the same defaults the review dialog pre-checks: empty fields are filled and missing fiscal years are added; existing values and years are never overwritten (`auto_enriched_from_file` company log).
- **New targets are auto-created** — they enter the pipeline at the `unreviewed` stage with `entered_by` stamped from the email custodian (MBOX pipeline) or the uploading session user. Duplicates are never re-created; creation runs under a per-name advisory lock so concurrent uploads can't double-insert.
- Analysis + screening jobs are dispatched for each created or auto-enriched company.
- **Note-driven inclusion** — the per-file upload notes can instruct the agent which companies to include or exclude (e.g. "only include Acme and Beta"); excluded companies are omitted from extraction entirely.

Other file types (financial statements, legal documents, MoMs, buyer/sponsor/advisor material) never auto-create companies — they describe counterparties or process, not companies on sale.

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

## Presentation page (`/presentation`)

A distraction-free, full-screen file viewer for PDF and PPTX files — the file only, no AI summaries. PDFs render in an `<iframe>`; PPTX renders via the Microsoft Office Online embed (`view.officeapps.live.com`), which fetches the file's signed URL.

- **Entry point:** the full-screen button on any `FilePreview` popup (chat files, company attachments, AI File Dump) navigates here with the file's S3 key. Direct visits with no file selected show the user's recently-opened files, paginated by 10 (most recent first).
- **Recently-opened files** are stored per-user in the `recent_files` table (one row per `(user_id, file_key)`; re-opening bumps `opened_at`). Signed URLs are regenerated server-side from the stored S3 key, so entries stay openable after the original signed URL expires.
- Layers: `RecentFileRepository` → `RecentFileService` (wired in `container.ts`).

### API Endpoints

- `GET  /api/recent-files?page=N` — list the current user's recent files (page size 10)
- `POST /api/recent-files` — record an open `{ fileName, fileKey }` (upsert)
- `GET  /api/recent-files/signed-url?key=…&name=…` — resolve a fresh signed URL for a file key

All three are session-authenticated via `auth()`.

## Live updates (Server-Sent Events)

The pipeline and company-detail views get live progress over **Server-Sent
Events** instead of `setInterval` polling. A single long-lived connection per
client replaces repeated `GET /api/screenings` and `GET /api/companies`
requests: the server re-queries on an interval and only emits a `data:` frame
when the relevant state actually changes (idle ticks send a heartbeat comment).

- `GET /api/screenings/stream?companyId=…` (or `?onlyL0=true`) — pushes the full
  screenings list whenever any row's `state`/`result` changes. Backs the Company
  Detail / dialog screening progress and the Pipeline's L0 pending-screening set.
- `GET /api/companies/stream` — pushes the compact set of companies with an
  in-flight AI Opinion run; when that set changes the client refreshes the list
  once so the spinner swaps for the verdict.

Both are `session`-authenticated (via `proxy.ts`): the browser's `EventSource`
sends the NextAuth cookie automatically — it cannot set the `X-Api-Secret`
header. The reusable stream builder lives in `src/lib/server/sse.ts`
(`changeStream`); the client subscribes via the `useEventStream` hook
(`src/hooks/useEventStream.ts`). Streams self-close at a lifetime cap below the
function timeout and `EventSource` reconnects automatically.

## CRM data pipeline

The Google Vault MBOX archive + parse pipeline and the CRM ingest pipeline (enrichment, employer/correspondent resolution, analytics marts) live in the `analytics` Postgres schema and are documented in [`data-pipeline/README.md`](data-pipeline/README.md).

The app (`public` schema) overlays human curation on top of `analytics` mart data via `employer_effective` and `correspondent_effective` views. Cross-schema dependency is one-directional: `analytics` reads `public` effective views; nothing in `public` depends on `analytics`.

## Google SSO sign-in

Google is used for **authentication only** — a successful SSO flow proves the
caller owns the email, never grants access on its own. The user must already
exist in the `users` table; unknown emails are rejected with the message
*"Your user is not registered in the system, please contact the Investment Brain team"*.
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

### Today's Recap — daily pipeline pulse (`/api/dashboard/pulse`)

The dashboard's "Today's Recap" card is a daily pipeline pulse produced by the
existing **Analyst agent**:

- `src/lib/dashboard/dailyPulseNarrator.ts` builds a Managing-Partner prompt
  (today vs the prior day, with the exception triggers) and sends it to the
  stateless Analyst agent (`getStatelessAgentGraph()` in
  `src/lib/agents/analysis`). The agent gathers the numbers itself via its data
  tools (`query_companies` with `created_after`/`created_before`,
  `get_company_stats`, `analyze_stalled_deals`), computes the deltas, and returns
  the finished recap as markdown. It runs under the workspace's context
  (`runWithWorkforceWorkspaceId`) so its tools scope correctly, including from
  the session-less cron.
- `DailyPulseService` (`src/lib/services/dailyPulseService.ts`) is a thin
  wrapper: it returns the day's cached markdown or, on a miss, asks the agent and
  persists the result. The pulse is stored once per UTC day per workspace in the
  `daily_pulse` table (via `DailyPulseRepository`), and the card renders the
  markdown as-is.
- The `daily-pulse` Vercel cron (`/api/cron/daily-pulse`, `0 0 * * *`)
  precomputes each day's recap at 00:00 UTC, so dashboard loads read the stored
  payload instead of paying the LLM cost. The read endpoint
  (`GET /api/dashboard/pulse`) still generates and upserts on the fly if the cron
  hasn't run yet that day, and `?refresh=1` forces a regenerate (used by the cron
  / ops).

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

## Copilot flavors (M&A, Investment, Combined)

The in-app Copilot ships in three selectable flavors, chosen per workspace:

- **`mna`** (default) — the M&A / acquisitions assistant: company/CRM tools,
  pipeline analysis, and Workforce handoffs (`CHAT_SYSTEM_PROMPT` +
  `DEFAULT_TOOL_LIST`).
- **`investment`** — the funds & investing assistant: read-only tools to see and
  analyze the workspace's funds, assets/holdings, investors (LPs), and fund
  sources, plus web search (`INVESTMENT_SYSTEM_PROMPT` + `INVESTMENT_TOOL_LIST`,
  backed by the fund tools in `src/lib/agents/analysis/tools/`:
  `get_fund_data_schema`, `query_funds`, `query_fund_assets`, `query_investors`,
  `query_fund_sources`).
- **`combined`** — a single assistant with access to BOTH tool sets, for
  workspaces that want one Copilot spanning the deal pipeline and the fund
  portfolio (`COMBINED_SYSTEM_PROMPT` + `COMBINED_TOOL_LIST`). `combinedTools` is
  the deduplicated union of `DEFAULT_TOOL_LIST` and `investmentTools` — the
  shared read tools (`web_search`, `query_files`, `lookup_crm`, `crm_insights`,
  `lookup_user`, `send_email`, `propose_workforce_handoff`) appear once.

How it's wired:

- The choice persists on `workspaces.copilot_agent` (a text column, default
  `'mna'`; migration `20260712000000_add_workspace_copilot_agent`).
- A superadmin picks the flavor from the **AI Copilot** dropdown in the workspace
  configuration panel (`/admin-portal`), which `PATCH`es
  `/api/workspaces/{id}` with `{ copilot_agent }`.
- `WorkspaceService.getCopilotAgent` / `updateCopilotAgent` read and write it;
  `COPILOT_AGENTS` / `normalizeCopilotAgent` (in `workspaceService.ts`) are the
  validation source of truth.
- `/api/chat` resolves the active workspace's flavor and calls
  `getAgentGraph(copilotAgent)`; the agent layer memoizes one `AgentGraph`
  singleton per flavor (they share the same checkpointer, so a thread's history
  is readable regardless of the active flavor).

## Workspace display currency (USD / IDR / CNY)

Each workspace has a **display currency** that relabels all money shown in the UI
— Fund Management figures and the company/pipeline Revenue / EBITDA / EV columns.

- **Relabel only, no FX conversion.** Only the currency prefix changes
  (`$` → `Rp` / `¥`, or the `USD` code → `IDR` / `CNY`). Stored values are
  untouched — company financials remain USD (`*_usd_mn`) and each fund keeps its
  own `base_currency`; the display just uses the workspace currency's symbol.
- Persisted on `workspaces.default_currency` (text column, default `'USD'`;
  migration `20260721000000_add_workspace_default_currency`).
- A superadmin picks it from the **Display Currency** dropdown in the workspace
  configuration panel (`/admin-portal`), which `PATCH`es `/api/workspaces/{id}`
  with `{ default_currency }`.
- `WorkspaceService.getDefaultCurrency` / `updateDefaultCurrency` read and write
  it; `WORKSPACE_CURRENCIES` (in `workspaceService.ts`) validates the payload.
- `src/lib/currency.ts` is the shared source of truth for the `Currency` type,
  `CURRENCY_SYMBOL`, `normalizeCurrency`, and the `formatMoneyMn` display helper
  (used by the company/pipeline views). The `/w/[workspaceSlug]` layout resolves
  the value and provides it via `WorkspaceCurrencyProvider`; client views read it
  with `useWorkspaceCurrency()` (Fund Management binds it through `useFundMoney()`).
- Every currency **picker** in the app (the Fund Management `CurrencyInput`
  dropdown, the transaction Price-per-share select, and the AI File Dump review
  currency picker) is locked to the workspace currency: it defaults to that
  currency and the other codes are shown disabled with
  `(currency not selected in the workspace)`. The `/admin-portal` Display
  Currency selector is the one exception — that is where the workspace currency
  is chosen, so all three remain selectable there.

## Runtime feature toggles

Features can be turned on/off **per workspace** at runtime by a superadmin from
the **Features** tab of the workspace configuration panel (`/admin-portal`).
This covers both code-consumed flags (Company Graph, Insights Dashboard, Fund
Management, Task Notifications, CRM Google Vault Sync, Chat Cache) and the main
sidebar sections (Dashboard, Pipeline, Master Data, CRM, AI File Dump,
Presentation, AI Workforce). Each workspace has its own set of toggles.

How it's wired:

- **Catalog** — `src/lib/features/catalog.ts` is the single source of feature
  metadata (key, label, description) and each feature's `defaultEnabled`.
  `featureEnvDefault(key)` resolves the baseline: the env var when explicitly
  set, otherwise `defaultEnabled` (nav sections default ON so the app is
  unchanged until an admin turns one off; opt-in flags default OFF).
- **Storage (database)** — overrides live in the dedicated `feature_flags` table
  (`workspace_id`, `feature_key`, `enabled`, `updated_at`, `updated_by`; PK
  `(workspace_id, feature_key)`), accessed via `FeatureFlagRepository`. One row
  per (workspace, feature).
- **Service / API** — `FeatureFlagsService`
  (`src/lib/services/featureFlagsService.ts`) merges stored rows with catalog
  defaults. The **Features** tab loads state via `GET /api/workspaces/{id}/features`
  and toggles via `PUT /api/workspaces/{id}/features` (both superadmin-gated).
- **Code-flag resolution** — `src/lib/features/overrides.ts` exposes
  `resolveFeatureOverride`, which `flags.ts` consults first. It resolves the
  request's active workspace via `getActiveWorkspaceId()` (driven by the
  `X-Workspace-Slug` header `proxy.ts` sets on `/w/<slug>/…` requests) and reads
  that workspace's rows. An override wins over the env/Vercel default, so toggles
  take effect across every existing flag consumer without consumer changes.
- **Sidebar gating** — the workspace layout (`src/app/w/[workspaceSlug]/layout.tsx`)
  resolves the full per-workspace flag map once via `resolveWorkspaceFeatureFlags`
  and provides it through `FeatureFlagsProvider`
  (`src/components/layout/FeatureFlagsContext.tsx`). `DashboardLayout` reads the
  context and hides any nav item whose `flag` is disabled — no per-page prop
  threading.

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

## In-app Copilot chat attachments

Files can be dropped **anywhere on the Copilot pane** (or picked via the
paperclip) and referenced by the agent. **Any file type** is accepted, up to
**100 MB** per file (`MAX_ATTACHMENT_BYTES`; larger files are rejected client-side
with a toast). These are **plain S3 objects** — deliberately NOT the AI File Dump
`files` table, and they never run through the extraction / company-matching
pipeline.

Lifecycle:

- **Attach → S3.** On drop, the browser fetches a presigned PUT URL from
  `GET /api/chat/attachments/upload-url` and uploads directly to S3 under
  `chat-attachments/{workspaceId}/…` (`generateChatAttachmentKey`). The key is
  scoped by workspace so a request can only ever reference its own tenant's
  files. The S3 object is the **durable** store — it persists across turns.
- **Send → Anthropic.** On every chat turn, `/api/chat` downloads each attached
  S3 object. **PDFs and images** are uploaded to Anthropic's Files API
  (`files-api-2025-04-14` beta, enabled on the chat `ChatAnthropic`) and
  referenced as `file` content blocks. **Every other type** (docx, pptx, xlsx,
  csv, json, …) is text-extracted via `extractTextFromFile` and inlined as a
  labelled text block — the Files API only accepts PDF/plaintext/images, so this
  is what lets *any* file type be sent. Because the S3 object persists, the file
  is re-referenced on **every subsequent turn** of the conversation.
- **Cleanup (done / stopped / disconnected).** The per-turn Anthropic upload is
  ephemeral: it is deleted once the streamed response drains (`after()`), and
  also on `req.signal` abort — which covers the UI's stop button and a dropped
  SSE connection. Teardown is idempotent so both paths are safe.
- **Multi-turn.** Because each turn's Anthropic upload is deleted, the `file`
  block persisted in the checkpointed history would 404 when the next turn
  replays it. So on every follow-up turn `AgentGraph.rewriteFileReferences`
  repoints the history's stale `file` blocks at the freshly re-uploaded id
  (`rewriteStaleFileBlocks`, reusing each message's id so the reducer overwrites
  in place) — or neutralizes them to a text placeholder if the file was removed.
- **Remove → S3 delete.** Removing a chip (`DELETE /api/chat/attachments`) or
  starting a new chat deletes the S3 object. This is the only thing that removes
  the durable file.

Layering follows the handler → service convention: both route handlers and
`/api/chat` delegate to `ChatAttachmentService`
(`src/lib/services/chatAttachmentService.ts`) for the presigned-URL,
S3-delete, and Anthropic upload/delete operations. Client state (the attachment
list, upload progress, and the transport body that carries `attachments`) lives
in `src/components/chat/ChatProvider.tsx`; the drag-drop / paperclip / chip UI is
`src/components/chat/ChatComposerAttachments.tsx`, wired into both the full
`ChatWindow` composer and the `AICopilotPane` composer.

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

## Relationship graph (Neo4j)

The relationship graph (`/graph`, served by `GET /api/graph`) is backed by
Neo4j and visualizes companies as nodes with `INVESTED_IN` / `PARTNER` /
`SUPPLIER` edges. **Postgres `companies` is the source of truth; Neo4j follows
it.**

- **Write-through mirror (repository layer).** `CompanyRepository` takes an
  optional `CompanyGraphMirror` (the `CompanyRelationRepository`, wired in
  `container.ts`). Every company write — `insert`, `insertMany`, `update`,
  `updateMany`, `delete` — mirrors to the graph: writes `MERGE` a node
  (mapping `target`→`name`, plus `segment`/`geography`/`ownership`/
  `pipeline_stage`→`pipelineStage`/`status`), deletes
  `DETACH DELETE` it. The mirror is **best-effort**: a Neo4j failure is logged
  and never fails the Postgres write. Repos constructed without a mirror (e.g.
  inside job handlers) simply skip it.
- **Full reconciliation.** `POST /api/graph/sync` dispatches a `graph_sync`
  background job (`CompanyGraphService.dispatchSync` → `runGraphSync`) that
  `MERGE`s a node for every company and prunes any graph node whose Postgres
  row no longer exists. Use it to repair drift (e.g. after writes that bypassed
  the mirror). Like all async work it reports lifecycle through `jobs` /
  `job_logs`.
- **Agent-authored relationships.** Linking logic lives in
  `CompanyRelationshipService.linkByName` (services layer): it records a directed
  edge between two companies (`source --[INVESTED_IN|PARTNER|SUPPLIER]--> target`)
  via `CompanyGraphService.relateCompanies`. Each side is matched by name
  (`CompanyRepository.findByNameFuzzy`); a company with no match is auto-created
  in Postgres at the **`discovered`** pipeline stage — a stage reserved for
  companies that surface only through a relationship, not through the L0–L5 deal
  pipeline. Discovered companies get their own section in the Master Data view
  (`src/views/MasterData.tsx`). `relateCompanies` upserts both nodes before the
  edge so the relation always attaches. Two workforce-only tools drive this:
  `update_company_relationship` (a single explicit edge) and
  `generate_company_card` (one edge per related company a Company Card surfaces).
- **Agent-read relationships.** The read-only `read_relationship_graph` tool
  (base tool, available to chat and workforce) queries existing edges without
  mutating anything. Given one company it lists every company that company is
  directly connected to (relation type + direction); given a list of companies
  it checks every unordered pair for a direct connection. Names are resolved
  with `CompanyRepository.findByNameFuzzy`; the graph reads go through
  `CompanyGraphService.getConnectedCompanies` / `getConnectionsAmong`
  (`CompanyRelationRepository` in the repository layer).
- **Combining companies (workspace admins only).** `POST /api/graph/combine`
  merges several companies into one surviving "main" company. Backed by
  `CompanyRelationshipService.combineCompanies`, it (1) records each absorbed
  company's display name and existing aliases on the main company's
  `companies.aliases` column, (2) reroutes every graph edge to/from the absorbed
  companies onto the main company via
  `CompanyGraphService.reassignAndDeleteNode` (preserving edge notes/evidence/
  date), and (3) deletes the absorbed Postgres rows (cascading their related
  data). Aliases are persisted first so the main node is mirrored into Neo4j
  before edges are rerouted onto it. The route is gated by
  `WorkspaceService.isWorkspaceAdmin` (platform superadmin or the `admin` role in
  the active workspace); the edit-mode "Combine companies" panel in
  `CompanyGraph.tsx` only renders for admins.
- **Aliases-aware matching.** `companies.aliases` (a `jsonb` string array) is
  consulted by `CompanyRepository.findByNameFuzzy` alongside `target` /
  `project_name`, so a relationship edge or ingest naming an absorbed company
  resolves to the surviving main company instead of spawning a duplicate
  `discovered` row. This applies automatically to the `generate_relationship_graph`
  and `update_company_relationship` tools, which resolve names through
  `findByNameFuzzy`.

- **Visualizer (`src/views/CompanyGraph.tsx`).** The `/graph` canvas
  (`react-force-graph-2d`) supports client-side filtering on company metadata
  (ownership, geography, **pipeline stage**, **status** — active vs dropped) and
  on edges (relationship type, has-evidence, date range). **Right-clicking a
  node** opens a context menu with *"Display only connected companies"*, which
  pins that node and restricts the graph to it plus its direct neighbours
  (companies sharing an edge in either direction); a chip in the filter sidebar
  clears the pin.

Connection is configured via `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD`
(see `src/lib/neo4j.ts`).

The Neo4j server itself is provisioned by `terraform/ec2/neo4j`, which also
manages an S3 backup bucket (`mna-neo4j-backups-<env>-<account_id>`). The
instance runs a systemd timer that dumps the database and uploads it to S3
daily; `neo4j-restore.sh` restores the latest dump. See
`terraform/ec2/neo4j/README.md` for the backup/restore workflow and the
data-preserving migration procedure.

## Async jobs

Long-running compute (AI screening, market screening, slide generation) is
dispatched via `JobDispatcher`/`dispatchJob`, which inserts a row into the
`jobs` table and schedules the work via Next.js `after()`. The runner
transitions the row through `pending → running → completed | failed | timed_out`,
and every state change is appended to `job_logs`. Transactional email is the one
async path that runs through Vercel Queues instead — see the forgot-password
section above for the rationale.

**Investment Tracks & matching.** Investment theses are managed as multiple
**Tracks** (backed by the `investment_thesis` table; `title` = name, `content` =
thesis, plus `pic` and the scan cadence). Track Settings (Pipeline header) CRUDs
them; the AI Market Scanner's Configure dialog selects which Tracks are active
(`is_active`) for scanning. When a company **enters L0** (created at L0 or
promoted to L0), `CompanyService` dispatches a `track_matching` job
(`TrackMatchingService.dispatch` → `runTrackMatching`) that asks the analysis
agent which Tracks the company fits and persists the result to
`companies.matched_track_ids` (falling back to a keyword heuristic when the agent
is unavailable). Matching is computed **once at L0 entry** — the UI shows the
persisted ids and never recomputes live, so pills stay stable when theses change.
Users can override the assignment per company in the Update Company dialog.

**Company Card generation** no longer uses the `jobs` table. `POST
/api/company-analysis` → `CompanyAnalysisService.dispatch` now enqueues an **AI
Workforce** run (`ai_workforce_queue`, `agent_name: 'company_card'`) whose
instruction drives the `generate_company_card` workforce tool. The tool
researches the company, persists the structured card to `company_analyses`
(which the Company Card UI polls via `GET /api/company-analysis`), and links the
company's related suppliers/partners/investors into the relationship graph
(creating unknown ones as `discovered`). The legacy `runCompanyAnalysis` job
wrapper remains for backward compatibility but is no longer dispatched.

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

### Scheduled deal resurfacing

Dropping a deal (Pipeline → Drop dialog) optionally takes a **"Resurface at"**
date (1/3/6/12 months or a custom date). The drop stores
`companies.resurface_at` and `companies.dropped_by` (the session user) alongside
the usual drop fields.

An hourly Vercel cron (`GET /api/cron/resurface-deals`, protected by
`CRON_SECRET` like the dispatch cron) runs `DealResurfaceService.processDue`,
which sweeps dropped companies whose `resurface_at` has passed (covered by the
partial index `idx_companies_resurface_due`). For each due deal it:

1. puts the deal back to `active` and clears the drop + schedule fields,
2. writes a `RESURFACED_TO_<stage>` entry to `company_logs`,
3. appends a deal note explaining the deal was automatically added back and
   quoting the original drop reason, and
4. enqueues a `deal_resurfaced` email (via the existing `send-email` Vercel
   Queue topic) to the user who dropped the deal and to the deal's PIC
   (`deal_captain` → `deal_sponsor`, both user ids; falling back to the
   matched Track's free-text `pic`, resolved to a platform user by name).

Notifications are best-effort: the reactivation stands even if no recipient can
be resolved or the queue is unavailable. A manual restore from the UI cancels
any pending resurface schedule.

### Fund Management

The **Fund Management** page (`/fund-management`, nav item gated by the
`FUND_MANAGEMENT_ENABLED` feature flag / `fundManagementEnabled` in
`src/lib/flags.ts`) presents funds, their holdings, per-holding transaction and
quarterly-valuation ledgers, editable fee structures, and by-investment-entity /
by-source-of-fund rollups. Money fields use a currency input (USD/IDR prefix,
live comma grouping, compact `$2M`/`$2k` on save). Editable numbers include
transactions, current share price, fee rates, quarterly snapshots, and
fund/holding financials, with live recomputation of MOIC / IRR / DPI and all
downstream metrics.

Funds, holdings, and their ledgers are backed by the Fund Management API
(`/api/funds/*` → `FundService` / `FundAssetLedgerService` /
`FundMetricsService`). **Investment Entities** and **Sources of Fund** are
persisted too: the `investors` table (`/api/investors`, `InvestorService`) and
the `fund_sources` table (`/api/fund-sources`, `FundSourceService`). The Add
Asset drawer picks an entity + source from these lists. The **By Investment
Entity** tab is an LP pro-rata view backed by `fund_investor_stakes`
(`/api/investor-stakes`, `FundInvestorStakeService`): each entity holds a
committed stake in one or more funds, and Commitment / Invested / Unrealized MV
/ Net Gain / MOIC are that entity's `fund total × (committed ÷ fund commitment
size)` summed across funds (edit an entity's per-fund stakes inline via
✎ stakes). The **By Source of Fund** tab groups each fund's live holdings by
`funding_source` (unmatched → "Others"). The view (`src/views/FundManagement.tsx`) is a
modular React implementation styled with Tailwind + the app's shadcn design
tokens (`bg-card`, `text-muted-foreground`, `bg-accent`, `text-success`, …), so
it is theme-aware and matches the rest of the app in light and dark. It is split
into co-located, single-responsibility modules under `src/views/fundManagement/`:

- `types.ts` — domain types (`Fund`, `Holding`, `Inv`, `Txn`, `Quarter`, `Investor`).
- `seed.ts` — the typed seed dataset (the single source of truth for the
  starting funds/holdings/investors; edit here to change what loads).
- `calc.ts` — pure calc + formatting (`computeInv`, `computeFoF`,
  `portfolioTotals`, `collectHoldingsByEntity` / `collectHoldingsBySource`,
  money/growth helpers).
- `CurrencyInput.tsx` — the USD/IDR currency amount editor (`CurrencyInput`,
  `MoneyInlineEdit`) + `formatCompact` / `formatGrouped` helpers.
- `glossary.ts` + `parts.tsx` — the glossary definitions and shared primitives
  (`GlossaryTerm` dotted-term tooltip, `Pill`, `DeltaBadge`, `MiniSpark`).
- `MetricCards.tsx` — the four header cards (Total Commitment, Total Invested,
  Unrealized Market Value, Total Value).
- `MoneyBreakdown.tsx` — the stacked "Money breakdown" bar (by fund / by holding type).
- `FundTable.tsx` + `HoldingDetail.tsx` — the "By fund" table (expandable funds →
  holdings → tabbed detail panel: Performance, Company & legal, Business, Share
  economics, Transactions, Historical value; the FoF variant swaps in a Capital
  account tab). The current share price on Share economics is editable and
  recomputes MOIC / IRR / return live.
- `InvestorTable.tsx` — the "By Investment Entity" LP pro-rata rollup (per-fund
  stake breakdown, `✎ stakes` inline editor) backed by `fund_investor_stakes`.
- `SourceTable.tsx` — the "By Source of Fund" rollup, grouping the live holdings
  by `funding_source` (with an "Others" bucket); both tabs have an inline
  "Add …" header button.

The flag prop `showFundManagement` is threaded through every page and view
alongside `showCompanyGraph` so the nav item renders consistently.
