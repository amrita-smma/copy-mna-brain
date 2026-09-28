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

## Skipping deployments

Vercel runs `scripts/skip-deploy.sh` as its [Ignored Build Step](https://vercel.com/docs/projects/overview#ignored-build-step) command for every branch (production and preview). The build is skipped when any of the following match the commit message:

| Pattern | Example |
|---|---|
| `[skip deploy]` anywhere in the message | `fix typo [skip deploy]` |
| `[skip ci]` anywhere in the message | `update docs [skip ci]` |
| Message begins with `chore:` | `chore: bump deps` |

To skip a build manually, include one of those strings in your commit message.

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

## Smart Files

Uploaded files are processed by the File Processing Agent (`src/lib/agents/file_processing`), which classifies each document (prospectus, shopping_list, mom, banker_communications, financial_statement, legal_document, market_study, other) and extracts structured data.

### Multi-company auto-ingestion

Deal-target file types — **prospectus** and **shopping_list** — can describe multiple companies. The agent emits a `companies` array (one entry per target, each with identity fields, financials, and FX adjustments; `prospectus_summary` mirrors `companies[0]` for backward compatibility) and `FileService.processUpload` auto-ingests every extracted target directly on upload:

- **HITL review only for pipeline companies** — a target that fuzzy-matches an existing company actively in the L0–L5 pipeline is never auto-modified; the file is set to `awaiting_review` and the user approves the proposed changes through the review dialog (per-field/per-year selection via `FileService.approve`). Everything else is auto-accepted and the file completes immediately.
- **Pre-pipeline matches are auto-enriched** — a target matching an existing company outside the pipeline (`unreviewed`, `market_screening`, `discovered`) is enriched in place with the same defaults the review dialog pre-checks: empty fields are filled and missing fiscal years are added; existing values and years are never overwritten (`auto_enriched_from_file` company log).
- **New targets are auto-created** — they enter the pipeline at the `unreviewed` stage with `entered_by` stamped from the email custodian (MBOX pipeline) or the uploading session user. Duplicates are never re-created; creation runs under a per-name advisory lock so concurrent uploads can't double-insert.
- Analysis + screening jobs are dispatched for each created or auto-enriched company.
- **Note-driven inclusion** — the per-file upload notes can instruct the agent which companies to include or exclude (e.g. "only include Acme and Beta"); excluded companies are omitted from extraction entirely.

Other file types (financial statements, legal documents, MoMs, buyer/sponsor/advisor material) never auto-create companies — they describe counterparties or process, not companies on sale.

### Fund updates extraction (async jobs)

Smart Files fund reporting workbooks and updates (`fund_updates`) are extracted via deterministic parsers (e.g. STARTECH master sheets) or dispatched as background jobs (`jobs.type = fund_update_extraction`). Async jobs return HTTP 202 and the client polls until extraction reaches `awaiting_review` or `failed`. Both upload (`/api/smart-files`) and reprocess (`/api/smart-files/[id]/reprocess`) routes configure `export const maxDuration = 600` to match the 10-minute extraction job timeout.

## CRM (Contact Relationship Management)

The CRM module manages contacts and their communication history.

### Database Tables

- **contacts** — Stores contact information (name, email, phone, company, title, type)
- **contact_messages** — Stores communication history linked to contacts

### Features

- Contact management (create, update, delete, search)
- Communication history per contact
- Integration with Smart Files for banker communications

### Banker Communications

Smart Files supports a "banker_communications" file type for CSV and MBOX exports (e.g., from Google Vault). When uploaded:

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

- **Entry point:** the full-screen button on any `FilePreview` popup (chat files, company attachments, Smart Files) navigates here with the file's S3 key. Direct visits with no file selected show the user's recently-opened files, paginated by 10 (most recent first).
- **Recently-opened files** are stored per-user in the `recent_files` table (one row per `(user_id, file_key)`; re-opening bumps `opened_at`). Signed URLs are regenerated server-side from the stored S3 key, so entries stay openable after the original signed URL expires.
- Layers: `RecentFileRepository` → `RecentFileService` (wired in `container.ts`).

### API Endpoints

- `GET  /api/recent-files?page=N` — list the current user's recent files (page size 10)
- `POST /api/recent-files` — record an open `{ fileName, fileKey }` (upsert)
- `GET  /api/recent-files/signed-url?key=…&name=…` — resolve a fresh signed URL for a file key

All three are session-authenticated via `auth()`.

## One company-filter vocabulary across the analysis tools

`src/lib/agents/analysis/tools/companyFilters.ts` owns the single filter
vocabulary shared by every analysis tool that scopes a cohort of companies:
`query_companies`, `get_company_stats`, and `send_email`'s `company_excel` /
`company_card` artifact specs.

Before it, each tool carried a hand-maintained subset of filters. The agent could
narrow a query by a column the matching export then silently ignored, and the
spreadsheet it mailed could disagree with the table it had just shown. Everything
now derives from one place:

- **`companyFilterShape`** — the zod raw shape, one entry per user-meaningful
  `companies` column (identity, classification, pipeline position, deal shape,
  people, narrative text, AI Opinion, financial bounds, every lifecycle
  timestamp, housekeeping flags) plus the graph filters below. Tools spread it
  into their own `z.object({ ...companyFilterShape, <tool-specific fields> })`.
  Add a filter once and all three tools accept it.
- **`mapCompanyFilters`** — snake_case tool args → the repository's
  `CompanyAgentFilters`, which `CompanyRepository.buildAgentConditions` turns
  into SQL for both `searchForAgent` (paged read) and `findForAgentStats`
  (full cohort).
- **`COMPANY_FILTER_DOC`** — the filter reference injected verbatim into each
  tool's description, so the model reads one identical list regardless of which
  tool it reaches for. `COMPANY_STAGE_DEFAULT_DOC` is deliberately separate: the
  read tools default to the L0–L5 committed funnel, while the Excel export has
  **no** stage default so "email me the whole pipeline" means the whole pipeline.
- **`resolveCompanyGraphFilter`** — relationship-graph filters (`connected_to`,
  `relation_type`, `has_relationships`) live in Neo4j, not Postgres. This
  resolves them into an id include/exclude list that `mergeGraphFilter` ANDs into
  the column filters, in a fixed number of graph queries regardless of cohort
  size (one neighbour lookup, or one whole-graph read — never one per row). Its
  deps arrive as a factory, so a query with no graph filter never constructs the
  Neo4j-backed services at all.

**Ids are the handoff between listing and exporting.** `query_companies` prints
each row's uuid in an `ID` column, and both `company_excel` and `company_card`
accept `company_ids`. The intended flow is query first, then export those exact
ids — the attachment then contains precisely the rows the user saw instead of a
cohort re-derived from filters. `CompanyAgentFilters.ids` also opts out of the
default `discovered`-stage exclusion (the caller already chose those rows) and
treats an **empty** array as "match nothing" rather than widening to the whole
workspace.

## Company Card → PowerPoint (email export)

The "L0 → L1 Submission" Company Card — the Overview tab of `CompanyDetailDialog`
(`CompanyOverviewSlide.tsx`) — can be exported as a `.pptx` and emailed by the
Copilot. Ask it to "send me the company detail / company card for X as a PPTX"
and it calls `send_email` with the `company_card` attachment spec.

Layers:

- **`src/lib/pptx/pptxElements.ts`** — the shape-level IR (rects, text boxes with
  formatting runs, tables) in inches on a 13.33"×7.5" slide, plus the px→in/pt
  helpers. Types only, so importing it pulls in nothing.
- **`src/lib/pptx/companyCardSlides.ts`** — pure renderer. Turns company +
  analysis data into positioned shapes mirroring the on-screen card (header +
  stage track, the two meta/deal-status box rows, and the three-column body:
  Target Overview + Indicative Financials + Proposed Deal Structure |
  Investment Thesis | L1 scope of work + Kill criteria). No DB, no browser.
- **`src/lib/pptx/writePptx.ts`** — writes `PptxElement[]` into a `.pptx` via
  pptxgenjs. Depends on nothing else.
- **`src/lib/services/companyCardSlideService.ts`** — data assembly. Composes
  `CompanyService.findByIdDTO`, `CompanyAnalysisService`, the Track list (for the
  Deal Sponsor/Captain fallback), the surfaced track variables, and the workspace
  display currency. Registered in `container.ts` as `companyCardSlideService`.
- **`buildCompanyCardAttachment`** in
  `src/lib/agents/analysis/tools/emailArtifacts.ts` — renders one card per
  requested company into a single deck and returns it as an `EmailAttachment`.
  Companies are addressed by `company_ids` (the ids `query_companies` printed —
  exact, no fuzzy matching) or by `company_names` as a fallback; the two lists
  are deduplicated on card title so naming a company both ways renders it once.

**Why no headless browser.** `slideExportService.exportSlidesToPptx` lays HTML
out in Chromium via Playwright, which is the right tool for the AI slide deck at
`/pipeline/:id/slides` (arbitrary AI-authored markup genuinely needs a browser).
The Company Card computes all of its own geometry, so it emits shapes directly
and never touches Playwright.

That matters operationally: `@playwright/test` is a **devDependency** and the
browser binary is only ever installed by the e2e CI job
(`.github/workflows/e2e-preview.yml`), never in the `Dockerfile` or a Vercel
build. Any code path that reaches `exportSlidesToPptx` therefore fails at runtime
in a deployed environment with `browserType.launch: Executable doesn't exist`.
`/api/slides/export-pptx` has that constraint today; the Company Card path
deliberately does not. **Do not route new server-side PPTX work through the HTML
path unless you are also arranging for a browser binary at runtime.**

**Pagination ("condensed and non-overlapping").** A slide is a fixed 630px box:
anything taller would be clipped by the extractor or would overprint the boxes
below it. So every block's wrapped height is estimated up front (`linesFor`) and
packed into per-column budgets; content that does not fit flows onto
"… (cont. N)" slides rather than overflowing. The kill-criteria block gets a
reserved share of column 3 so it can never be squeezed off the first slide.

**Rich text.** Text boxes carry per-run `bold`/`italic`/`color`, so the card's
`**Label**: value` lead-ins survive into PowerPoint as real bold instead of being
flattened. `htmlToPptxElements` emits the same runs for leaves that mix
formatting, so the AI slide deck export benefits too.

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
   then redirects to the post-login destination (see **Deeplink preservation**
   below — `/workspace` unless a deeplink was preserved).

The button is hidden when `NEXT_PUBLIC_GOOGLE_CLIENT_ID` is unset, leaving only
email/password sign-in.

### Deeplink preservation across login

A logged-out hit on a protected URL must come back to that URL after signing in,
otherwise every emailed or bookmarked deeplink effectively lands on the wrong
page. `src/lib/callbackUrl.ts` owns both halves of that round trip:

- `loginUrlWithCallback(pathAndSearch)` builds the `/login?callbackUrl=...` URL.
  Every gate that bounces to `/login` uses it: the `/w/` branch of `proxy.ts`
  (the main one), `src/app/w/[workspaceSlug]/layout.tsx`,
  `src/components/auth/ProtectedRoute.tsx` (session expiring mid-visit), and
  `src/lib/legacyWorkspaceRedirect.ts` (pre-migration flat URLs, which re-enter
  the bridge after login and forward on to their `/w/<slug>/...` equivalent).
- `sanitizeCallbackUrl(raw)` reads it back on the login page and in
  `/api/auth/sso`. The value comes from a user-controlled URL and ends up in a
  redirect `Location`, so it is validated in both directions: same-origin
  absolute paths only, rejecting protocol-relative `//host` and its `/\host`
  variant, embedded control characters, `/login` itself, and `/api/*`. The SSO
  `token` param is stripped so it can't be replayed.

The param name matches the one NextAuth appends when redirecting to
`pages.signIn`, so those bounces are preserved for free.

A preserved `/w/<slug>/...` deeplink skips the `/workspace` picker entirely — the
URL already names its workspace, and `/w/` routes resolve the workspace from the
URL slug rather than session state (see the layout's note on never calling
`switchWorkspace`). Membership is still enforced by `proxy.ts` and the layout, so
a deeplink into a workspace the user can't enter falls back to `/workspace`.

### Launcher token exchange (`/?from=launcher&token=eyJ...`)

The Brain Launcher embeds this app in an iframe and hands over the signed-in
user's identity as a **launcher-signed RS256 JWT** via `?token=` on the URL.
`proxy.ts` intercepts any request carrying `?token=` and routes it to
`GET /api/auth/sso`, which:

1. Verifies the JWT against the launcher's JWKS endpoint
   (`LAUNCHER_ORIGIN/.well-known/jwks.json`) via `jose` — signature, expiry,
   `iss` (must equal `LAUNCHER_ORIGIN`) and `aud` (must equal
   `NEXT_PUBLIC_APP_URL`) are all enforced.
2. Extracts the verified `email` claim and looks the user up in `users`.
   Unknown emails are rejected with `UserNotRegisteredError` — no account is
   auto-provisioned.
3. Establishes a standard NextAuth JWT session (`Set-Cookie`) and redirects to
   the clean callback URL with `token` stripped from the URL.

Set `LAUNCHER_ORIGIN` to the launcher's origin
(`https://brain.starcapital.co.id`, `https://brain-stg.starcapital.co.id`, or
`http://localhost:3000`) and `NEXT_PUBLIC_APP_URL` to this app's own origin so
the `aud` claim is enforced correctly. See `.env.example` for details.

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

## Iframe embedding (Brain Launcher)

This app can run standalone (`mna.sqe.co.id`) **or** be embedded as an `<iframe>`
inside the Brain Launcher (`https://brain.starcapital.co.id`, its staging peer,
and `http://localhost:3000`). Embedding is entirely env-gated so the standalone
deployment keeps its safe defaults.

**Config** (see `.env.example`, `src/lib/iframe.ts`):

- `IFRAME_EMBED_ENABLED` — master switch. When `true`, the CSP `frame-ancestors`
  header lists the launcher origins and NextAuth cookies become
  `SameSite=None; Secure; Partitioned` (CHIPS). When unset/`false`, framing is
  locked to `'self'` and cookies stay `SameSite=Lax`.
- `NEXT_PUBLIC_IFRAME_ALLOWED_ANCESTORS` — whitespace/comma-separated origin
  allowlist, shared by the server CSP header (`next.config.ts`) and the
  client-side `postMessage` origin checks. Defaults to the launcher origins.

**Why these are needed** (all browser-enforced, brain-side):

1. **Framing.** A cross-origin frame is refused unless the framed app sends
   `Content-Security-Policy: frame-ancestors <launcher origins>` (and does *not*
   send `X-Frame-Options: DENY|SAMEORIGIN` — we never do; `frame-ancestors`
   supersedes it). Set in `next.config.ts`'s `headers()`.
2. **Cross-site cookies.** The session cookie is written from inside a
   cross-site frame, so it must be `SameSite=None; Secure; Partitioned` to be
   stored/sent under third-party-cookie partitioning. Set in `src/auth.config.ts`
   (secure cookie names preserved so `proxy.ts` still recognises them).
3. **Token staleness.** The `?token=<launcherJwt>` deeplink carried at `src`
   time (consumed once by `proxy.ts` → `/api/auth/sso`) expires (~5 minutes)
   while the frame stays mounted. Re-auth is handled by the launcher reloading
   the frame `src` with a fresh `?token`, triggered by the postMessage channel
   below.

**postMessage protocol** (`src/lib/iframe.ts`, `src/components/iframe/IframeBridge.tsx`).
Every message carries the single neutral `source: 'brain-portal'` tag — the
launcher is generic across all brains, so a brand-specific tag would be dropped.
Both sides validate `event.origin` against the allowlist and check the `source`
field; the brain never posts with `targetOrigin: '*'`. Tokens are **never** sent
over postMessage — re-auth happens via the launcher reloading the frame `src`.

- **Brain → Launcher** (`source: 'brain-portal'`):
  - `{ type: 'ready' }` — the embedded app has mounted.
  - `{ type: 'auth-expired' }` — a request 401'd or the session is gone; the
    launcher should reload the frame `src` with a fresh `?token`.
  - `{ type: 'signed-out' }` — user signed out inside the brain (ack after a
    launcher-initiated `logout`).
- **Launcher → Brain** (`source: 'brain-portal'`):
  - `{ type: 'logout' }` — propagate logout; the brain signs out and replies
    `signed-out`.
  - `{ type: 'navigate', path }` — same-origin, relative-path navigation.
  - The launcher does not drive these yet, so the brain's listeners are
    harmless no-ops until it does.

The launcher gives the iframe a **fixed, full-height pane** (it does not shrink
the frame to content), so the app renders to fill 100% height and there is no
content-resize message.

> The launcher must implement the matching side: embed us with a fresh
> `?token`, listen for `brain-portal` messages, and reload the frame `src` on
> `auth-expired`. Nothing the brain does can bypass the browser's framing or
> third-party-cookie policies — the launcher origins must be correct and served
> over HTTPS in production.

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

## App shell (chat-first landing + center console)

The product is chat-first: the Copilot is the landing page, and the left sidebar
carries both of the app's navigations — chat history and the page list — behind a
two-tab toggle. Pages open in a center console beside the Copilot.

- **One shell, mounted once.** `src/components/layout/AppShell.tsx` is rendered
  by `src/app/w/[workspaceSlug]/layout.tsx`, above the routed `children`. That
  placement is the whole design: switching tabs is a Next.js soft navigation
  that swaps only the page, so the sidebar, the Copilot pane, and any in-flight
  chat stream stay mounted. (The shell used to be `DashboardLayout`, wrapped
  *inside* each of 13 views, which remounted everything on every navigation.)
  Views therefore render bare content — no view wraps the shell.
- **Two states.** On the landing (`/w/<slug>` and its `/w/<slug>/chat` alias)
  the Copilot fills the console; `AppShell` derives that from the route rather
  than writing it to storage, so the state can't leak onto the next page.
  Collapsing the Copilot navigates to `layout:last-tab` (or the first
  feature-enabled page). On a page route the page fills the console with the
  Copilot docked right; expanding it keeps the URL, so collapsing returns to the
  same page. The only chrome over the console is the full-screen toggle.
- **One sidebar, two tabs.** `ChatSidebar`
  (`src/components/chat/ChatSidebar.tsx`) opens with a **History / Pages**
  segmented toggle above the "New Chat" button, and shows one list at a time:
  chat history, or the app's destinations (`SidebarPagesNav`). The choice
  persists under `layout:sidebar-section`. This replaced a strip of icon tabs
  across the top of the console — two competing navigations pointing in
  different directions, which read as one confusing bar. Choosing a page calls
  `revealConsole()`, because the Copilot may be sitting full-screen over the
  console and navigating behind it would look like nothing happened.
- **Page registry.** `src/lib/navigation/consoleTabs.ts` holds `CONSOLE_TABS`
  (slug, path, label, feature flag, purpose) and is deliberately free of UI
  imports, because the Copilot's `navigate_page` tool builds its argument enum
  from it. `SidebarPagesNav` (`src/components/layout/SidebarPagesNav.tsx`)
  attaches the `lucide-react` icons and renders the list as real
  `<WorkspaceLink>`s. `visibleConsoleTabs(flags)` is the single flag filter,
  shared by that list and by `AppShell`'s collapse target, so the two can't
  disagree about which pages are reachable.
- **`LayoutControlContext` wraps the whole shell** and carries the three actions
  that move the two panes past each other:
  - `revealConsole()` — docks the Copilot. Called by anything in the transcript
    that sends the user to a page (the "Open X" navigation chip, a company
    chip). Without it the console would swap pages *behind* an expanded Copilot
    and the click would look like it did nothing.
  - `expandCopilot()` — puts the Copilot full-screen. Called by every "New chat"
    trigger and by selecting a chat from history, so opening a conversation
    lands the user in it rather than in a 384px docked column (or, on a tab
    route with the pane collapsed, nowhere visible at all).
  - `focusCopilot()` — the existing "Analyze using AI" path.

  The provider wraps the entire shell rather than just the panes because the
  sidebar's "New chat" buttons live outside `SidebarInset`. It returns no-ops
  outside the shell, so `ChatSidebar` still works in the mobile history drawer.
- **Company mentions become "Open &lt;company&gt;" chips.** When the Copilot's
  answer names a company, the transcript renders a chip that opens it at
  `/companies/<id>`. This replaced a chip that recorded the `navigate_page`
  destination ("Open Pipeline") — a tab the user can already see — with
  something specific enough to act on. The `navigate_page` skill itself is
  unchanged and still navigates on a live call.

  Getting an id for a name is the interesting part. The client never sees a
  tool's raw table — it sees the model's prose answer, which names companies but
  carries no ids, so there is nothing to build a URL from. (`query_companies`
  does print an `ID` column for the *model* to hand to the export tools; that
  column is not what the chip renderer reads.) Rather than guess or re-query by
  name, the company-returning tools append a hidden `COMPANY_MENTIONS_JSON`
  manifest of `{ id, name }` pairs
  (`src/lib/navigation/companyMentions.ts`), and the client keeps only the
  entries whose name appears in the answer's own prose. That filter matters: one
  query can return fifty rows, and chipping all of them would bury the answer.
  Matching is case-insensitive and word-boundary anchored, so `Acme` does not
  light up inside `Acmetric`.

  Because the chips are a pure function of the prose, the model's writing style
  decides whether they appear at all — and the failure mode is a summary. "12
  active deals at L1, mostly Japanese industrials" names nobody, so it produces
  no chips and no way to click through. `COMPANY_MENTIONS_PROMPT_GUIDE` (same
  file, appended to every chat flavor that has company tools) biases the model
  toward landing every count, breakdown and ranking on named companies, written
  exactly as the tool returned them. It lives next to `selectMentionedCompanies`
  on purpose: the rules it states *are* the matcher's rules, and
  `companyMentions.test.ts` asserts the guidance's own worked examples really do
  chip, so the advice can't drift away from the implementation.

  `companyDetailPath` (`src/lib/navigation/companyPath.ts`) is the single place
  the destination is encoded. `/companies/<id>` and `/pipeline/<dealId>` render
  the same `CompanyDetail` view — both segments are the company id — the
  difference being that the pipeline route frames the company as a deal in the
  funnel. Mentions with no id (a file's `matched_companies` can hold bare name
  strings) stay inert badges rather than linking to `/companies/undefined`.
- **Chat history pages in as you scroll.** `GET /api/copilot/chats` returns 30
  chats at a time (`limit`/`offset`, clamped server-side) rather than every
  conversation the account has ever had — `CopilotChatsService.list` reads
  `limit + 1` rows and drops the extra, so `hasMore` costs nothing beyond the
  page itself. `ChatSidebar` renders a zero-height sentinel under the last row
  and appends the next page when an `IntersectionObserver` sees it, 200px before
  it reaches the viewport. `ChatProvider` owns the paging state: `loadMoreChats`
  guards re-entry with a ref (the sentinel can fire again before React commits
  the loading flag) and dedupes appended rows by id, since a chat touched
  between two page loads moves up the ordering and would otherwise arrive twice.
  `refreshChats` re-reads as many chats as are currently on screen instead of
  just the first page, so a title landing mid-session doesn't collapse a list
  the user has already scrolled through. The `last_active_at DESC` ordering
  carries an `id DESC` tiebreak — chats touched in one transaction share a
  timestamp, and without it a row can straddle two pages while another is never
  served.
- **Empty chat.** `AICopilotPane` greets the user by first name ("Ask away,
  Nico!") with the composer and a few suggestions centered beneath it, replacing
  the old canned "Hello! I'm your M&A assistant" feature-list bubble.

### Page-aware Copilot skills

Two chat-only tools connect the conversation to the console beside it. Both are
in `chatOnlyTools` — a Workforce run has no browser, so neither reaches it.

- **`navigate_page`** moves the console. The tool emits a
  `<!-- NAVIGATE_PAGE_JSON:{…} -->` marker (same pattern as
  `propose_workforce_handoff`); the format lives in
  `src/lib/navigation/navigateAction.ts` so the client can parse it without
  pulling LangChain into the browser bundle.
  `src/components/chat/NavigationActionHandler.tsx` performs the navigation, and
  the interesting part is *not* navigating: the marker is persisted in the tool
  output and so re-renders forever. Each chat starts with a baseline of the
  `nav_id`s already in its transcript and only acts on ids appearing after it,
  so re-opening an old chat from history replays nothing. `ChatMessageBubble`
  renders the record as an "Opened X" link — clickable, never auto-firing.
- **`read_page_context`** reports what's on screen, so "summarize this" or "this
  deal" resolves without the user restating it. `PageContextProvider` derives
  the tab and path from the route; a view can enrich it with the record or
  filters in view via `useSetPageDetail` (wired in `Pipeline` and
  `CompanyDetail`). The value reaches `ChatProvider`'s transport body through
  the `src/lib/chat/pageContextStore.ts` singleton — needed because
  `ChatProvider` is mounted at the app root, *above* `PageContextProvider`, so
  React context can't reach it. `/api/chat` sanitizes the payload
  (`sanitizePageContext`: unknown tab dropped, path shape enforced, detail
  clamped — it is browser-supplied and ends up in a prompt) and passes it as
  `configurable.pageContext`, the same seam `thread_id` and `userEmail` use.
  A view with a single deal on screen also publishes that deal's `companies.id`
  via `useSetPageCompanyId` (wired in `CompanyDetail` and `CompanyDetailDialog`).
  It travels as its own `companyId` field rather than inside the `detail` prose,
  must be a well-formed UUID to survive sanitization, and is rendered into the
  tool output as an id to pass verbatim to `company_id`-taking tools — which is
  what stops a near-identical company name from resolving to a sibling record.

### Insights

An **insight** (`/w/<ws>/insight/<id>`) is a document the Copilot writes for
you — a brief, a report, a dashboard-style page — saved as a self-contained
HTML page. Figures are captured when it is written; an insight does not update
itself unless you edit or refresh it.

- **Create and edit from chat.** Ask the Copilot to write or change an insight.
  It shows a preview card first, and nothing is saved until you approve it. An
  edit card shows what changed.
- **Point at a section.** On an open insight you can select sections and ask the
  Copilot to change just those.
- **Reports.** A report is planned with you before it is written, and must
  follow a fixed structure.
- **Sources.** Figures cite their sources, and a figure that couldn't be found is
  marked *Unavailable* rather than guessed.
- **Version history.** Every change is saved as a new version. You can preview
  any earlier version and roll back to it.
- **List.** The insight list can be searched, filtered by agent or owner,
  archived and restored. One insight per workspace can be featured.
- **Safety.** Insight HTML only ever renders inside a sandboxed iframe
  (`InsightFrame`); never render it anywhere else.

#### Insight templates

- Upload an `.html` file (up to 250,000 characters) as a template, or save an
  existing insight as one.
- Attach a template in chat to have the Copilot write an insight in that layout.
  The library shows how many insights came from each template.
- Deleting a template moves it to **Recently deleted**, where it can be restored
  or removed for good.

#### Large documents

A chat turn can write roughly 20,000 characters. For anything bigger, the
Copilot offers to hand the job to the **AI Workforce**, which runs it in the
background.

- **Editing a large insight.** Chat edits rewrite the whole document, so in
  chat `get_insight` returns only an outline for an insight over that size,
  with an instruction to hand the edit (insight id plus the selected section
  or element) to the Workforce. The Workforce applies the edit directly as a
  new version; the old version stays restorable from the insight's history.
- **Tier floor.** On Auto, a turn made while an insight is open runs at
  `medium` or above, since the router would read a short edit request as
  `low` and its 90 s budget cannot fit a rewrite. A tier picked by hand is
  never overridden.
- **After a timeout.** Every budget wrap-up offers the Workforce. The next
  turn does not get the whole-document tools (`propose_insight_create`,
  `propose_insight_edit`, `replace_insight_document`), and it is told to hand
  off a document request rather than retry it.

#### Scheduled refresh

- An insight can be refreshed on a schedule (also listed under AI Workforce →
  Routines), or on demand with **Refresh now**.
- A refresh publishes one new version, only if the run succeeds. If nothing
  changed, the version is marked *No changes* and no email is sent.
- If the agent needs input during a refresh, it asks the insight's owner and
  waits for their answer before publishing.

### Editing company records from chat (`update_company_details`)

Any editable field on a company can be changed by asking the Copilot — its
name, profile (segment, geography, website, ownership, company focus, project
name), deal fields (source, deal type, stake, deal size, banker, banker source,
advisor, doc type, NBO date, live flag, workflow status, key rationale,
comments, remarks, thesis content), and per-year financials (revenue / EBITDA /
EV in USD millions).

The write itself only ever happens in the **Workforce**.
`update_company_details` is registered in `workforceOnlyTools`, so chat cannot
call it: the Copilot resolves the company with `get_company_details`, then
proposes a `propose_workforce_handoff` card carrying an exact field-level
instruction (company id, field, new value). Nothing is mutated until the user
clicks **Assign to Workforce**, and the resulting run's trace records the
before/after — the tool returns each change as `field: old → new`. Once
assigned, the card grows a **View task in AI Workspace** link
(`WorkforceHandoffCard`) that deep-links to `/ai-workforce/tasks/<queueId>` so
the user can watch the run instead of hunting for the row; it falls back to the
queue root when the id isn't a UUID (the route validates it and 404s
otherwise), and clicking it calls `revealConsole()` first, since the copilot
pane may be full-screen over the console. A
`tools/index.test.ts` case pins the tool to the workforce list and out of the
chat/combined/vc lists so it can't drift into an inline write.

Implementation notes (`src/lib/agents/analysis/tools/update_company_details.ts`):

- Core fields go through `CompanyService.updateFromDTO` (log action
  `UPDATED_DETAILS_BY_AI_WORKFORCE`) and yearly figures through
  `CompanyService.updateFinancials` (`UPDATED_FINANCIALS_BY_AI_WORKFORCE`), so
  a detail edit lands on the same normalized write path as the FE company form.
  `FinancialUpsertInput` gained `ev_usd_mn` for this — an omitted key still
  keeps the stored value, which is what the FE editor relies on. Those two
  service calls are two commits, so the error path reports which half landed
  rather than implying a rollback (same shape as `promote_to_l0`'s
  update-then-promote).
- **Derived figures are recomputed, not carried over.** `updateFinancials` now
  recalculates `ebitda_margin` and `ev_ebitda` from the merged revenue / EBITDA
  / EV, and nulls them when an input is missing or the denominator is zero.
  Carrying the stored ratio over meant a revenue edit published a margin
  computed against the *old* revenue on the company card and the Excel export.
  Each ratio is gated on **its own** inputs (margin on revenue/EBITDA, multiple
  on EV/EBITDA), not on "any figure changed" — the FE charts PUT a single
  metric, and a revenue-only save must not wipe a multiple that ingest stored
  for a year with no EV on file. `revenue_cagr_vs_prior` is deliberately
  untouched: it spans two fiscal years and belongs to the screening pipeline.
- **Years whose figures already match are skipped**, both in the write and in
  the reported summary, so re-running the same instruction doesn't rewrite rows
  or claim changes that didn't happen.
- **Pipeline state is out of scope, loudly.** `pipeline_stage`, `status` /
  `dropped_*`, `ai_opinion_*` and the user-reference columns are *rejected with
  a pointer to the owning tool* rather than silently stripped — a stage move
  belongs to `promote_to_l0` / the HITL-gated `promote_to_l1`, a drop to
  `drop_company`, the verdict to `save_ai_opinion`. Silently dropping them
  would let the agent report a change that never happened, and accepting
  `pipeline_stage` would route around the promotion approval gate.
- A rename whose new name already belongs to a **different** company is
  refused, so a rename can't fork one company into two records and break every
  subsequent name lookup. The check is `CompanyRepository.findByExactName` —
  a case-insensitive whole-name match on target / project name / aliases — not
  `findByNameFuzzy`, which strips legal suffixes and substring-matches: the
  fuzzy helper answers "did you mean this company?" and would both refuse an
  innocent "Acme Corp" → "Acme Holdings" (an unrelated "Acme Industries" wins
  the rank) and miss a real duplicate it happened to rank second.
- Dropped companies stay editable (matching `CompanyService`, which blocks only
  lifecycle moves after a drop) — a dropped record can still be corrected.

## Record-scoped dialogs (`CompanyDetailDialog` and friends)

`CompanyDetailDialog` is opened from seven places — Pipeline, Dashboard, Master
Data, Smart Files, Company Graph, the Insights module, and Market Screening
results. It is a *record-scoped* dialog: it fetches its own data per company, so
how the parent holds "which company is selected" decides whether the user sees
the right one.

**The parent derives `open` from the selection; it never keeps a second
boolean.**

```tsx
{selectedCompany && (
  <CompanyDetailDialog
    key={selectedCompany.id}
    company={selectedCompany}
    open={!!selectedCompany}
    onOpenChange={(open) => {
      if (!open) {
        activeCompanyRequestIdRef.current = null;
        setSelectedCompany(null);
      }
    }}
    onUpdate={fetchPipelineData}
  />
)}
```

That block is what Dashboard and Smart Files render (`onUpdate` refreshes the
parent's own list). Three parts are load-bearing: the `{selected && …}` guard
unmounts the dialog on close, `open={!!selected}` keeps one source of truth, and
`key={selected.id}` forces a fresh instance if a parent swaps records without
closing first. The `activeCompanyRequestIdRef` clear belongs only on parents
that fetch. Pipeline and Market Screening pass the row through, so they null the
selection and clear an edit-mode flag, and they have no request ref.

**Why a separate `open` boolean is a bug.** `setDialogOpen(false)` hides the
dialog but leaves `selectedCompany` set, so the dialog stays *mounted*. Internal
`company` state is seeded from the prop once and re-synced in a `useEffect` on
`companyProp.id`, one paint after the next open is already visible. `analysis`
(including its logo), `notes`, `documents`, `screenings`, and `stageHistory`
come from a second effect on `[open, company.id]` (`refreshCompany`,
`fetchDetails`, `fetchAnalysis`) and stay on screen until those requests
return. This was the "opening a company card sometimes blips to the older card"
report. It affected Dashboard, the Insights module, and Market Screening
results, which each kept a separate open boolean. Pipeline and Master Data
already derived `open`; they were missing only `key`. Smart Files already
unmounted on close.

**Async open paths need a staleness guard.** Smart Files chips carry id + name,
Master Data and Insights do not have the full row in hand, and Dashboard falls
back to `getCompanies({ id })` for companies missing from its cached list
(dropped companies). Each of those fetches is awaited before `setState`,
because the inline editor writes back from the prop. Dashboard skips the
fetch when the row is already in its cached list. Two clicks can resolve out of
order. Smart Files drops a late success, and both its empty-result toast and
its `catch` toast check the ref:

```tsx
const activeCompanyRequestIdRef = useRef<string | null>(null);

const openCompany = useCallback(async (companyId: string) => {
  activeCompanyRequestIdRef.current = companyId;
  try {
    const data = (await getCompanies({ id: companyId })) as CompanyData | null;
    if (activeCompanyRequestIdRef.current !== companyId) return;
    if (!data) {
      toast.error("Could not load company");
      return;
    }
    setSelectedCompany(data);
  } catch {
    if (activeCompanyRequestIdRef.current === companyId) {
      toast.error("Could not load company");
    }
  }
}, []);
```

Dashboard's `handleCompanyClick` and Insights' `openCompany` check the ref
before `setSelectedCompany` and null it on close. Their `catch` blocks only
`console.error` and do not set state, so a stale rejection cannot open a
company; they do not consult the ref before logging. Dashboard also returns
early for mobile (it navigates to the full-screen profile) and for a cache hit,
after assigning the ref. Master Data checks the ref before setting the company,
before the error toast, and before clearing its loading flag. Closing nulls the
ref on every parent that has one, so an in-flight success after close is
dropped.

**Don't double-fetch.** The dialog loads the DTO, details, and analysis itself
in the `[open, company.id]` effect. `CompanyGraph.handleNodeClick` seeds from
the graph node and does not fetch — a second in-flight fetch raced that effect
and flashed stale content, which the comment on that function records.
`CompanyGraph` is the one accepted variant of the open-state pattern: it keeps
a separate `dialogOpen`, and is safe because it has `key={selectedCompany.id}`
and never fetches before open. New code should use the derived form. The
awaited pre-open fetch above is the one fetch a partial record needs; it
finishes before the dialog mounts.

The rule, with a reviewer's checklist, lives in
`.claude/rules/dialog-open-state.md`; `/review-implementation` and `/pr-review`
both check diffs against it.

## Copilot flavors (M&A, Investment, Combined, VC)

The in-app Copilot ships in four selectable flavors, chosen per workspace:

- **`mna`** (default) — the M&A / acquisitions assistant: company/CRM tools,
  pipeline analysis, Workforce handoffs, and AlphaSense/Valyu/web search
  (`CHAT_SYSTEM_PROMPT` + `DEFAULT_TOOL_LIST`).
- **`investment`** — the funds & investing assistant: read-only tools to see and
  analyze the workspace's funds, assets/holdings, investors (LPs), and fund
  sources, plus web search and Valyu search (`INVESTMENT_SYSTEM_PROMPT` +
  `INVESTMENT_TOOL_LIST`, backed by the fund tools in
  `src/lib/agents/analysis/tools/`: `get_fund_data_schema`,
  `search_investments`, `query_funds`, `query_fund_assets`,
  `get_fund_asset_details`, `query_investors`, `query_fund_sources`,
  `query_ledger_entries`). `query_ledger_entries` is the movement-level tool —
  it reads the posted ledger rows themselves off the same shared model the
  [Ledger](#ledger) page renders from, so a figure quoted in chat matches the
  figure on screen; the other fund tools report roll-ups.
- **`combined`** — a single assistant with access to BOTH tool sets, for
  workspaces that want one Copilot spanning the deal pipeline and the fund
  portfolio (`COMBINED_SYSTEM_PROMPT` + `COMBINED_TOOL_LIST`). `combinedTools` is
  the deduplicated union of `DEFAULT_TOOL_LIST` and `investmentTools` — the
  shared read tools (`web_search`, `valyu_search`, `query_files`, `lookup_crm`,
  `crm_insights`, `lookup_user`, `send_email`, `propose_workforce_handoff`)
  appear once. `query_ledger_entries` is in this set too.
- **`vc`** — the Venture Capital & Growth Equity assistant: a flavor of the
  existing Copilot (not a separate agent, graph, or endpoint) powered by
  `VC_SYSTEM_PROMPT` + `VC_TOOL_LIST`. It combines curated fact-retrieval tools
  across pipeline companies, fund portfolios, and CRM context with
  `get_investment_theses` (active/inactive workspace theses/tracks),
  `calculate_investment_returns` (deterministic scenario math for proceeds, MOIC,
  and IRR), and enhanced external research via Valyu (`valyu_search` and
  `valyu_extract_content`, with `web_search` as fallback/corroboration). The model
  dynamically selects tools and owns qualitative synthesis and recommendations
  (`invest` / `pass` / `investigate further`); there is no mandatory module
  sequence or end-of-turn evaluation. External companies and funds not in
  workspace data are researched seamlessly using cited external search. No schema
  migration or new table is required (persisted via `workspaces.copilot_agent = 'vc'`).

### AlphaSense research (`alphasense_search`)

`alphasense_search` (`src/lib/agents/analysis/tools/alphasense_search.ts`) is the
one tool registered for **every** agent flavor — M&A chat, AI Workforce,
investment, combined, and VC. It lives in the shared read-only base list
(`tools` in `src/lib/agents/analysis/tools/index.ts`) plus `investmentTools` and
`vcTools`, so any agent can reach the firm's AlphaSense subscription: sell-side /
broker research, SEC and global filings, earnings-call and expert-call
transcripts, company presentations, and licensed news.

The transport is `src/lib/alphasense.ts` (`AlphaSenseClient`), a thin wrapper
over the [AlphaSense Agent API](https://developer.alpha-sense.com/agent-api/quickstart):

1. `POST https://api.alpha-sense.com/auth` — OAuth2 password grant
   (`x-api-key` + client id/secret + user email/password) returns an
   `access_token`. Tokens are cached in-module keyed by api key + username and
   refreshed 60s before `expires_in`, so several tool calls in one chat turn
   authenticate once. A 401/403 on a GraphQL call triggers exactly one forced
   re-auth and retry.
2. `POST https://api.alpha-sense.com/gql` — the `genSearch.auto` mutation starts
   a conversation and returns its id; the `genSearch.conversation` query is then
   polled every 2s until `progress` reaches `1.0` (or `error.code` is set).
   GenSearch is asynchronous and typically takes 20–90s.

Because the run is long, the tool bounds it twice: a 150s poll budget inside
`runGenSearch` (which returns the partial `markdown` flagged `timedOut` rather
than hanging the turn) and a 180s `withToolTimeout` backstop for a hung socket.
The answer is returned as markdown with AlphaSense's inline `[[n • Source]]`
citations preserved.

Configuration is the five `ALPHASENSE_*` env vars in `.env.example`
(`ALPHASENSE_API_KEY`, `ALPHASENSE_CLIENT_ID`, `ALPHASENSE_CLIENT_SECRET`,
`ALPHASENSE_EMAIL`, `ALPHASENSE_PASSWORD`). When any are unset the tool returns a
message naming the missing variables and telling the agent to fall back to
`valyu_search` / `web_search` — it never throws, so an unconfigured environment
degrades instead of breaking a chat turn. Routing guidance in each flavor's
system prompt: prefer `alphasense_search` when the answer should rest on filings,
transcripts, or analyst research; `valyu_search` for broad multi-source /
proprietary-dataset research; `web_search` for quick general lookups;
`search_news` first for recent market news the internal lake may already cover.

Every invocation is logged to the `alphasense_tool_calls` table
(`AlphasenseToolCallRepository` / `AlphasenseToolCallService`, wired into
`createContainer`) for historical lookback: the resolved workspace, the exact
`prompt` sent to GenSearch, the call's `status`
(`success` / `timed_out` / `error` / `not_configured`), the AlphaSense
`conversation_id`, and the returned markdown or error message. Each row also
carries `chat_thread_id` and `original_question` — the LangGraph `thread_id`
and the user's own un-reformulated question for that turn, both of which
travel via the runtime `configurable` (set once in `/api/chat`,
`/api/v1/chat`, and `/api/v1/chat/stream`) rather than as tool arguments, so
the model can't fabricate them. Logging is best-effort: a DB failure is
swallowed and warned, never surfaced as a broken chat turn.

### VC external research architecture (Valyu & Web)

The VC Copilot integrates external research tools for live diligence across companies, sectors, fund managers, exit comps, and integrity checks:

- **Synchronous chat research tools:**
  - `valyu_search`: Primary search engine for financial filings, market research, sector dynamics, news, transcripts, and web sources with clickable markdown citations.
  - `valyu_extract_content`: Targeted factual extractor for deep inspection of 1–3 specific authoritative URLs discovered during research.
  - `web_search`: Fallback search engine for general web queries and cross-source corroboration.
- **Coverage boundaries & factual limits:** Valyu provides strong coverage for public markets, SEC/regulatory filings, industry research, and web sources. Documented sources do not guarantee complete private cap tables, private fund performance/LP data, or undisclosed metrics; these remain gaps when not found. Undisclosed private metrics are explicitly reported as data gaps rather than estimated or guessed.
- **Fast chat vs. deferred DeepResearch/Batch boundary:** Fast synchronous search (`search`) and targeted extraction (`contents`) power interactive chat to keep conversational latency low. Long-running **Valyu DeepResearch** (multi-minute deep investigations) and **Batch** research workflows are **intentionally deferred** to a future AI Workforce background integration and are **not implemented** in the synchronous Copilot chat.
- **Agentic tool use:** The LLM selects tools dynamically based on user intent and evidence needs (no rigid tool sequences or fixed topic pipelines) and owns all investment synthesis and recommendations.

**Name resolution ("how is X doing?").** On the fund side a name the user types
can be a holding, a fund, an investor/LP, or a source of capital, and the user
is not expected to say which. `search_investments` fuzzy-matches the name across
all four entity types in one call (returning type, match strength, headline
metrics, and the `fund_asset_id` for holdings), and both the investment and
combined prompts require it before any single-type lookup. The matching itself
lives in `src/lib/agents/analysis/tools/fuzzySearch.ts` — a dependency-free
scoring ladder (exact → prefix → substring → token overlap → acronym →
Dice/Levenshtein typo fallback) that ignores case, punctuation, and legal
suffixes ("acme" resolves "Acme Holdings Pte Ltd"). `get_fund_asset_details`
(`asset_name`) and `query_fund_assets` (`fund`) use the same matcher.

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

## Sector agents (`@minerba`, `@dikti`, `@bangun`)

Specialist agents, one per sector, alongside the general Copilot:

| Agent | Sector |
| --- | --- |
| `@minerba` | Mining and minerals |
| `@dikti` | Education |
| `@bangun` | Construction and property development |

- **Bind an insight to an agent.** An insight can be assigned to a sector
  agent. Chatting from that insight, and its scheduled refreshes, then use that
  agent. Its version history shows which agent wrote each version.
- **Context.** When you chat from an open insight, the agent already knows the
  insight's contents.
- **Retired agents.** A retired agent can't be chosen for new insights. Refresh
  schedules on it pause until the insight is moved to another agent.
- **Code.** Agents are defined in code: `src/lib/agents/sector/registry.ts` lists
  them, and each has a folder under `src/lib/agents/<key>/`.

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
  dropdown, the transaction Price-per-share select, and the Smart Files review
  currency picker) is locked to the workspace currency: it defaults to that
  currency and the other codes are shown disabled with
  `(currency not selected in the workspace)`. The `/admin-portal` Display
  Currency selector is the one exception — that is where the workspace currency
  is chosen, so all three remain selectable there.

## Workspace soft delete (archive / reinstate)

A workspace can be **soft-deleted** (archived) instead of dropped: the row stays,
so nothing is destroyed and the slug stays reserved, but the workspace becomes
inaccessible to everyone.

- Persisted on `workspaces.deleted_at` (nullable `timestamptz`; non-null means
  archived; migration `20260915000000_add_workspaces_deleted_at`). The
  `workspaces_slug_key` unique constraint is deliberately left as a plain
  (non-partial) unique index — **an archived workspace keeps its slug**, so the
  slug can't be reused while the workspace could still come back.
- **Only a superadmin may archive or reinstate.** Enforced twice: the routes
  return 403, and `WorkspaceService.softDeleteWorkspace` / `restoreWorkspace`
  re-check `isSuperadmin` themselves and throw `NotSuperadminError`.
  `DELETE /api/workspaces/{id}` archives; `POST /api/workspaces/{id}/restore`
  reinstates. Both are idempotent.
- **It disappears from every listing.** `WorkspaceRepository.findAll` and
  `UserWorkspaceRepository.findMembershipsForUser` both filter on
  `deleted_at IS NULL`, so an archived workspace drops out of the `/workspace`
  picker, the nav switcher, `getAccessibleWorkspacesForUser`, the JWT's
  `workspaces` claim, and background sweeps (the vote-closing cron, graph sync,
  and synced-custodian-mailbox lookups) in one move. The single exception is
  `GET /api/workspaces?all=true` → `listWorkspacesIncludingDeleted`, which is
  superadmin-only and backs the admin portal's archived section.
- **It is inaccessible, not merely hidden.** Three layers:
  1. `proxy.ts` validates `/w/<slug>` against the JWT's `workspaces` claim —
     which no longer lists the archived workspace — and redirects members to
     `/workspace`. No DB access, so this is the cheap path.
  2. `src/app/w/[workspaceSlug]/layout.tsx` calls
     `workspaceService.findActiveWorkspaceBySlug(slug)` and redirects to
     `/workspace` when it returns null. This is the only gate with DB access and
     therefore the one that catches a **superadmin** (whom the proxy waves
     through every slug by design) and anyone holding a JWT issued before the
     archive.
  3. `WorkspaceService.isMember` / `isWorkspaceAdmin` return false for an
     archived workspace **even for a superadmin**, so the `update({ workspaceId })`
     session switch in `auth.ts` can't make one the active workspace.
- **Admin portal UI** (`/admin-portal`): live workspaces list as usual; archived
  ones sit in a collapsed **Deleted (n)** disclosure underneath, visible only to
  a superadmin. Selecting one replaces the settings tabs with an archived banner
  and a **Reinstate workspace** button; a live workspace gets a **Delete
  workspace** button with a confirmation dialog. Reinstating restores the
  workspace exactly as it was — data, members, slug and settings all intact.

## Workspace table layouts (column order / hidden / groups)

The managed data tables — Pipeline inbound & outbound (`pipeline-inbound:<view>`,
`pipeline-outbound:<view>`), Master Data (`master-data`), Smart Files
(`smart-files`), and Market Screening results (`market-screening-results`) — let
users reorder columns, hide them, and gather contiguous columns into collapsible
groups. That arrangement is a **workspace setting, not a per-user preference**:
one member rearranging a table changes it for everyone in the workspace, and the
arrangement follows them to any browser or device.

- **Storage (database)** — one row per (workspace, table) in
  `workspace_table_layouts`, primary-keyed on `(workspace_id, table_id)`
  (migration `20260811000000_workspace_table_layouts`). `layout` is a jsonb
  `ColumnLayoutState` blob (`{ order, hidden, groups }`) — see
  `src/lib/table/columnLayout.ts` for the pure ordering/hiding/grouping logic.
  This replaces the previous `mna:table-layout:v1:*` localStorage persistence,
  which was per-browser.
- **Backend** — `WorkspaceTableLayoutRepository` (workspace-scoped data access) →
  `TableLayoutService` (validates the incoming blob with
  `parseColumnLayoutState`, dropping unknown keys, and constrains `tableId` by
  shape) → `/api/table-layouts` (`GET` all layouts for the active workspace,
  `PUT` one, `DELETE ?tableId=` to reset). The workspace always comes from the
  request context, never from the body: reads use `getActiveWorkspaceId()`,
  writes use `getActiveWorkspaceIdOrThrow()` so they fail closed with a 403
  rather than stamping the no-active-workspace sentinel onto a row.
- **Authorization** — any signed-in **member** of the workspace may read *and*
  write. That is deliberate (a shared table everyone can arrange) and is looser
  than `default_currency`, which is superadmin-only; the trade-off is
  last-write-wins with no in-app audit surface. `updated_by`/`updated_at` are
  recorded on every write if that ever needs surfacing.
- **Frontend** — `TableLayoutProvider` (mounted in the `/w/[workspaceSlug]`
  layout, **keyed by slug** so switching workspace remounts and refetches)
  fetches every layout in a **single** request, so N tables never mean N
  requests. `useColumnLayout(tableId, columns)` reads its table's layout from
  that store, reconciles it against the live column set (`initLayout` appends
  new columns and drops removed ones), and writes back — debounced 400ms and
  optimistic — only on real user edits, tagged with the `tableId` the edit was
  made against. Specifically:
  - Hydration never writes, so merely opening a table cannot overwrite the
    workspace's layout.
  - Writes are suppressed until the initial `GET` **succeeds**, so a failed read
    can't be followed by a save that overwrites a layout that never loaded.
  - Pending debounced writes are flushed on unmount rather than dropped.
  - **Reset** deletes the stored row rather than saving today's defaults, so the
    table keeps following future changes to its declared columns.

## Runtime feature toggles

Features can be turned on/off **per workspace** at runtime by a superadmin from
the **Features** tab of the workspace configuration panel (`/admin-portal`).
This covers both code-consumed flags (Company Graph, Insights Dashboard, Fund
Management, Task Notifications, CRM Google Vault Sync, Chat Cache) and the main
sidebar sections (Dashboard, Pipeline, Master Data, CRM, Smart Files,
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
- **Tab gating** — the workspace layout (`src/app/w/[workspaceSlug]/layout.tsx`)
  resolves the full per-workspace flag map once via `resolveWorkspaceFeatureFlags`
  and provides it through `FeatureFlagsProvider`
  (`src/components/layout/FeatureFlagsContext.tsx`). `SidebarPagesNav` reads the
  context and hides any page whose `flag` is disabled — no per-page prop
  threading. `AppShell` consults the same map when deciding which page to open,
  and the copilot's `navigate_page` tool refuses a destination the workspace has
  switched off.

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
with a toast). These are **plain S3 objects** — deliberately NOT the Smart Files
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
  is what lets *any* file type be sent. An HTML file over 20,000 characters is
  sent to chat as an outline instead (see *Large documents*). Because the
  S3 object persists, the file is re-referenced on **every subsequent turn** of
  the conversation.
- **Cleanup (done / stopped / disconnected).** The per-turn Anthropic upload is
  ephemeral: it is deleted once the streamed response drains (`after()`), and
  also on `req.signal` abort — which covers the UI's stop button and a dropped
  SSE connection. Teardown is idempotent so both paths are safe.
- **Multi-turn.** Because each turn's Anthropic upload is deleted, the `file`
  block persisted in the checkpointed history would 404 when the next turn
  replays it. So on every follow-up turn `AgentGraph.rewriteFileReferences`
  repoints the history's stale `file` blocks at the freshly re-uploaded id
  (`rewriteStaleFileBlocks`, reusing each message's id and `additional_kwargs` so
  the reducer overwrites in place and the recorded attachment refs survive) — or
  neutralizes them to a text placeholder if the file was removed.
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

## Product telemetry (PostHog)

Analytics is PostHog, reached three ways. All three exist because ad/tracker
blockers silently drop a meaningful slice of browser-side analytics, which makes
a blocked user indistinguishable from an absent one.

**1. Same-origin ingest proxy (`/ingest`).** `posthog-js` is initialised in
`src/instrumentation-client.ts` with `api_host: '/ingest'` rather than PostHog's
own domain, so blockers filtering by hostname (`*.posthog.com`) don't match.
`/ingest` is a pair of `rewrites()` in `next.config.ts`, not a route handler:
rewrites resolve in the platform's edge routing layer, so no serverless function
is invoked per captured event. PostHog serves ingestion and static assets from
two different hosts, so `/ingest/static/*` and `/ingest/*` are rewritten
separately — see `posthogUpstreams` in `src/lib/posthog-proxy.ts`, which derives
the `<region>-assets` host and returns nothing when PostHog is unconfigured (the
path then simply 404s). `skipTrailingSlashRedirect` is on because posthog-js
addresses its endpoints with trailing slashes (`/e/`, `/flags/?v=2`).

`src/proxy.ts` matches `/ingest/:path*` purely to **strip credentials** —
the browser attaches session cookies to `/ingest` because it is same-origin and
cannot know the request is about to be proxied to a vendor. Without that strip,
every captured event would ship a live session token to PostHog.

**2. Identity.** `PostHogIdentityTracker` (mounted once in `Providers`)
identifies the user off the resolved NextAuth session, keyed on their **UUID**,
and refreshes person properties via `setPersonProperties`. It deliberately does
not live on the login page: `before_send` drops everything captured on `/login`
(see `src/lib/posthog-events.ts`), and since `identify()` is itself a captured
`$identify` event, identifying there sent nothing — losing the anonymous →
identified merge and the `email` / `name` person properties. Identity events are
now explicitly exempt from that path filter.

The tracker also registers the user's **email as a super property**, so every
event carries both the email and the UUID (the UUID is already the `distinct_id`,
so it needs no equivalent). This is an interim measure while identities migrate
from email-keyed to UUID-keyed persons — it makes a user findable by raw event
search without depending on person profiles having merged. **To stop sending
emails, flip `SEND_EMAIL_WITH_EVENTS` in `src/lib/posthog-identity.ts` to
`false`.** Do not simply delete the `register` call: super properties persist in
each browser's localStorage, so a deleted call would leave existing sessions
stamping email indefinitely. The flag drives an `unregister` on the off path,
which clears the stored value. (`posthog.reset()` on sign-out already clears it
too, so a shared browser never carries one user's email into the next session.)

**3. Server-side capture.** The events that matter most for per-user attribution
are emitted with `posthog-node`, where no blocker can reach them:
`user_signed_in` (`src/auth.ts`), `deal_promoted` / `deal_demoted`
(`CompanyService.promote` **and** `promoteMany`, so chat bulk moves are counted
too — those carry `bulk: true` instead of a company name), `file_uploaded`
(`FileService.processUpload`) and `ai_screening_started`
(`ScreeningService.prepare`). Their client-side counterparts were removed, so
these are not double counted. `promote` takes a trailing telemetry-only `opts`
argument (`triggeredByUserId`, `hasDocument`) — `hasDocument` is passed in
explicitly because the attachment is uploaded *after* the promote call returns,
so the server cannot observe it. Use
`captureWorkspaceEvent` for anything inside a workspace and `captureUserEvent`
only where there genuinely is no workspace (sign-in). Server-side capture covers
agent-tool and pipeline callers that have no browser at all, but gives up
autocapture, `$pageview` and session replay — it complements the client, it does
not replace it.

**Blocked-client signal.** `ClientHealthProbe` HEADs `/ingest/static/array.js`
once per tab session for a signed-in user; a rejected fetch (`ERR_BLOCKED_BY_CLIENT`)
means blocked, while any HTTP response — including a 5xx — counts as reachable,
so a broken proxy is never misreported as an ad blocker. A blocked client POSTs
to `/api/client-health`, which records `client_telemetry_blocked` server-side
against that user. The probe also runs on `/workspace` and `/consent`, which
resolve no workspace, so `ClientHealthService` falls back to `captureUserEvent`
rather than stamping the fail-closed `NO_ACTIVE_WORKSPACE_ID` sentinel as a real
PostHog group. The route and probe paths deliberately avoid the words
`analytics`, `tracking`, `telemetry`, `posthog` and `ph`, all of which appear in
the filter lists this is trying to measure.

**4. Activity heartbeat — the usage tracker.** `src/lib/posthog-heartbeat.ts`,
fired from `recordActivity` in `src/proxy.ts`. This is the authoritative "who is
using the product, and how much" signal, and the only one an ad blocker cannot
touch: the proxy already decodes the session JWT on every gated request, so
usage is counted server-side with nothing running in the browser.

Time is sliced into fixed five-minute windows (`HEARTBEAT_INTERVAL_MS`) and each
user emits at most one `user_activity_heartbeat` per window **per instance**,
carrying that window's index as `heartbeat_bucket`. The bucket is derived from
wall-clock time rather than from process state, which is what lets the throttle
be a per-instance in-memory `Map` with no shared dedup infrastructure and no
database round-trip on the request path: two instances serving the same user in
one window build a *byte-identical* event — same `$insert_id`
(`<user>:<bucket>`) and same `timestamp` (the window's start, not the moment of
the request, since PostHog's dedup tuple includes it) — so the duplicate is
dropped at ingest. `uniqExact(heartbeat_bucket)` collapses any that slip
through. Active time is `distinct buckets x interval`.

This measures **active** time (windows containing at least one request), not
time-on-page. That is deliberate: the client-side `$prev_pageview_duration` it
replaces counts an idle background tab as usage. For the same reason
`isActivityPath` excludes `/api/auth/*` — the NextAuth client polls
`/api/auth/session` on an interval and on window focus, which would make an
abandoned tab read as active forever — along with `/ingest`, `/api/cron/*`,
`/api/queues/*`, `/api/healthcheck` and `/api/client-health`.

The heartbeat posts directly to PostHog's `/i/v0/e/` capture endpoint with
`fetch` (via `waitUntil`, so it never delays the response). A bare `fetch`
rather than `posthog-node` because the proxy runs per request with no
meaningful process lifetime to flush a buffered client against — there is
nothing for a client library to batch. It deliberately does *not* route through
our own `/ingest` rewrite either: the request originates on the server, where
there is no blocker to evade, and doing so would bounce it back through the
proxy. The `email` event property honours the same `SEND_EMAIL_WITH_EVENTS` kill
switch as the client super property, so flipping that flag stops both surfaces.
`$set: { email }` is *not* gated on it — that flag governs per-event stamping,
not the person properties `identify` would set anyway, and it is what gives a
permanently blocked user a searchable person profile instead of a bare UUID.

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

- `/api/auth/signup` — M2M user creation (same invite-email flow as
  session-gated `POST /api/users`; see "Account invite flow" below)
- `/api/auth/api-keys`, `/api/auth/api-keys/:id` — chat API key management (above)

**Adding a new admin route:** place it under `src/app/api/auth/<route>/`, and add
its path to the `matcher` array in `src/proxy.ts` so the `X-Api-Secret` gate
applies. Do not add a per-handler session check — auth happens in the middleware.

## Account invite flow (admin-created users)

The admin portal's User Management section (`/admin-portal`, above the
per-workspace panel → "Add user") provisions a brand-new account via
session-gated `POST /api/users` (superadmin-only).
Machine callers that already hold `ADMIN_SECRET` can use the equivalent
`POST /api/auth/signup` instead. Both go through `AuthService.signUp`. The
admin supplies only a name and email — no password is ever collected from or
chosen by the admin:

1. `AuthService.signUp` creates the `users` row with a random, hashed,
   never-communicated password (so the account cannot be signed into until
   the invite link below is used).
2. It mints a token in `reset_password_tokens` (7-day TTL — longer than the
   1h forgot-password TTL, since a new user may not check email right away)
   and publishes an `account_invite` message to the same `send-email` topic
   used by the forgot-password flow.
3. The consumer route renders the `account_invite` template
   (`EmailService.sendAccountInviteEmail` /
   `renderAccountInviteEmail`) and emails a link to
   `/reset-password?token=<token>` — the exact same page and
   `/api/auth/reset-password` endpoint the forgot-password flow uses.
4. If the invite email never arrives (queue outage, wrong inbox, expired
   link), the user has an ordinary escape hatch: "Forgot password?" on the
   login page re-issues a fresh reset link for the same account.

Reusing `reset_password_tokens` and `/reset-password` instead of a
dedicated invite-token table/page keeps "set a password for the first time"
and "reset a forgotten password" as one mechanism with two entry points.

## User Management (admin portal)

`/admin-portal` renders a "User Management" section above the per-workspace
"Workspace Configuration" panel: a superadmin-only global directory of every
platform user, backed by `UserService` and `PATCH/DELETE /api/users/[id]`,
`POST /api/users/[id]/reactivate`, and `POST /api/users/[id]/send-reset-link`
(all session-gated superadmin routes, following the same `auth()` +
`workspaceService.isSuperadmin` gate as `POST /api/users` and
`/api/workspaces/[id]`).

Supported actions per user:
- **Add** — see "Account invite flow" above.
- **Change name / change email** — inline edit, `UserService.updateProfile`.
  A new email must not already belong to a different user.
- **Send password-reset link** — `UserService.sendResetLink` delegates to
  `AuthService.forgetPassword`, the same mechanism the self-service "Forgot
  password?" flow uses, just triggered by an admin instead of the user.
- **Deactivate / Reactivate** — soft delete, not a hard `DELETE FROM users`.

**Why deactivate instead of a hard delete.** `users.id` is referenced by
~40 foreign keys across the schema. A few (company-vote sessions/ballots)
are `onDelete: restrict`, so a real hard delete throws outright for any user
who has ever voted; most others are `onDelete: cascade` (workspace
memberships, chat history, consents, recent files, reset tokens), so a hard
delete would silently wipe them for everyone else. `users.deactivated_at`
(migration `20260916000000_add_users_deactivated_at.sql`) mirrors the
`workspaces.deleted_at` soft-delete pattern instead: a non-null value blocks
sign-in (checked in `AuthService.signIn` / `signInWithGoogleToken` /
`signInWithLauncherToken`, raised as `AccountDeactivatedError`) but the row,
its history, and every foreign key referencing it are left untouched, so a
superadmin can reactivate the account at any time. A superadmin cannot
deactivate their own account (`CannotDeactivateSelfError`) — that would lock
them out with no one left to reverse it.

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

  The sidebar also has a **Highlight** combobox: selecting companies pins the
  graph to exactly that selection plus the companies on the connection paths
  between each highlighted pair (up to 5 alternative paths per pair, ≤ 5 hops,
  mirroring the Neo4j `MATCH path = (a)-[*1..5]-(b)` traversal), bypassing the
  other filters. Beneath it, the **"Show connected companies"** checkbox widens
  that view to also include every company with a direct edge to a highlighted one
  (and the edges attaching them), so a highlight can be read in the context of its
  immediate neighbourhood. The shared `neighborIds` helper in
  `src/lib/graph/nodeStyle.ts` computes that neighbour set (also used by the
  right-click pin) from the *unfiltered* edge set, so it stays an intrinsic
  relation rather than a product of the active edge filters.

- **Shareable filter URLs (`src/lib/graph/graphFilterParams.ts`).** Every graph
  filter is mirrored into the query string, so a filtered view can be shared as a
  plain link: `q` (the sidebar search term), `highlight` (repeated, company ids),
  `connected=1` ("show connected companies"), `connectedTo` (the right-click pin),
  `ownership`, `geography`, `sector`, `stage`, `status`, `rel` (enabled
  relationship types), `evidence=1`, `from`, `to`. `q` is the odd one out: it
  doesn't filter the node set, it centres and zooms the canvas on the matching
  company, and it's applied on `onEngineStop` (in place of the default
  fit-to-screen) because it needs the force layout to have settled before nodes
  have coordinates to centre on. Multi-value filters use repeated params rather than a
  delimiter so values containing commas survive a round trip, and defaults are
  omitted so an unfiltered graph keeps a clean `/graph` URL. Unknown or malformed
  values fall back to their default, so a hand-edited link can't wedge the view;
  the one non-obvious encoding is a blank `rel=`, which carries "every
  relationship type de-selected" (an omitted `rel` means the opposite, all
  enabled). `CompanyGraph` decodes the query string once on mount to seed its
  filter state and thereafter writes the URL itself via `history.replaceState`
  (not `router.replace`, which would re-run the server component and remount the
  canvas mid-filtering).

  `connectedTo` is the exception to decode-once: the company detail dialog the
  graph itself renders embeds the relationship snippet, whose "Show in
  relationship graph" button links back to `/graph?connectedTo=<companyId>` — a
  soft navigation on the *same* route, which leaves the view mounted and only
  updates `useSearchParams()`. So that param is read live, and the URL sync keeps
  it until the id has been consumed (resolved to its node, or found to be absent
  once the graph has loaded), so a pending deep link is never stripped before it
  applies.
- **Company detail snippet (`src/components/pipeline/CompanyRelationshipGraph.tsx`).**
  Both the company detail page (`CompanyDetail.tsx`) and the company detail
  dialog (`CompanyDetailDialog.tsx`, opened from Master Data, Dashboard
  insights, market-screening results and the graph itself) embed a filter-free
  miniature of the graph on their Details tab, showing just that company and the
  companies directly connected to it, plus a **"Show in relationship graph"**
  button that deep-links to
  `/graph?connectedTo=<companyId>`. It is served by `GET /api/graph/connections?companyId=`
  → `CompanyGraphService.getCompanyNeighbourhood`, which fetches the focal node,
  its direct neighbours and every edge among that set in a fixed handful of
  queries (no per-neighbour fan-out). Company nodes carry no `workspace_id`, so
  the route scopes both the focal company and its neighbours through
  `CompanyService.findExistingIds` (one batched Postgres lookup). The canvas is
  read-only: node drag, panning and zooming are all disabled, it is sized from
  its container via a `ResizeObserver` (rather than force-graph's 800×600
  default, which would overflow the card), and it re-runs `zoomToFit` on every
  simulation tick and on resize so the neighbourhood stays centred and fully in
  frame. Nodes are drawn at `NODE_SCALE` (circle *and* label metrics scale
  together) so a handful of companies fit without scrolling.
- **Shared canvas styling (`src/lib/graph/nodeStyle.ts`).** Relation colours and
  labels, stage-based node colour, EV-derived node sizing, label wrapping and the
  node canvas painter live in one module used by both the full graph page and the
  detail-page snippet, so the two canvases always read identically.

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

**Company Card regeneration on a stage move.** Every pipeline stage move
refreshes the card, so it never goes stale as a deal advances.
`CompanyService.promote`, `promoteMany` and `updateFromDTO` (the Current Stage
dropdown — only when the stage actually changes) call
`CompanyAnalysisService.regenerate`, which enqueues a `company_card` workforce
run with `trigger_meta.source = 'stage_move'`. It is best-effort: the stage move
is already committed, so an enqueue failure is logged, never thrown. Unlike
`dispatch` it is **not** idempotent on a completed card (that is the point), but
it *is* idempotent on an in-flight run: a `findActiveByCompanyId` pre-check plus
a per-minute `idempotency_key` (uniquely indexed on `ai_workforce_queue`), so
even two concurrent moves on one company produce one run. That key is unique for
all time, so when it collapses onto a run that already finished or was cancelled
(cancel marks a run `failed`) the enqueue is retried without a key — otherwise a
cancel-then-retry inside the same minute would return a 202 pointing at a dead
row. A bulk promote goes
through `regenerateMany`, which resolves the in-flight set and the company names
in one batched query each rather than two reads per deal. The "Regenerate" button
routes through the same path via `POST /api/company-analysis` with `force: true`.

**Freshness and conflict resolution** (`src/lib/companies/cardFreshness.ts`).
`company_analyses.created_at` records when the card *content* was produced.
There is one row per company and it is upserted in place, so the completion
write **re-stamps `created_at`** — left alone it would freeze at the first-ever
generation and the comparison below would drift further out with every refresh.
(`updated_at` cannot serve here: it also bumps on the `status → 'processing'`
write at the start of a run, which would make the card look fresher than its
content and wrongly beat a newer document. One consequence of re-stamping:
`DashboardInsightsRepository.getCompanyCardStats` counts card generations in a
window, regenerations included, not only first-time ones.)

Whether a *prior card exists* is decided by **content** (`hasCardContent`), not
by `status` and not by the timestamp. `status` would be wrong because a failed
run overwrites only `status`/`error_message`, so a row sitting at `failed` can
still hold the last good card and a retry must weigh it rather than start blank.
The timestamp alone would be wrong because `created_at` defaults to `NOW()` on
the `status: 'processing'` insert that opens every run, so a first run that
failed leaves a dated but empty row — treating that as a card would inline an
empty one and let its processing-start timestamp beat genuinely older documents.
A regeneration reads the prior card **before** marking the row processing (so the
row is never deleted first), then collects the company's dated source material:
`deal_documents` (dated by `created_at`) and Smart Files matched to the company
(dated by the business `file_date`, falling back to `created_at`). Two clocks are
used deliberately: a date-only `file_date` is weighed against the card at the
**end** of its day, so a file dated today does not lose to a card generated
earlier the same morning, but sources are *ranked against each other* on the raw
instant — otherwise a file dated `2026-03-01` would outrank a deal document
actually created at `2026-03-01T22:00Z`. Those, their dates, and the
previous card's sections are inlined into the agent prompt with
one rule: **when two sources disagree, the later-dated one wins.** A document
dated after the card's `created_at` overrides the card; an older one loses to it and is
used only for facts the card doesn't cover; an undated document can never win a
conflict. Anything the newer sources don't contradict is carried forward, so a
refresh never silently drops still-valid findings.

### Stuck-job cleanup scheduler

If a request is aborted before `after()` fires, a job can get stuck in `pending`
forever; if the runner process crashes mid-work, a job can get stuck in
`running`. A background sweep (`JobService.cleanupStuckJobs`) transitions any
`pending` or `running` rows whose age exceeds `timeout_seconds + buffer` into
`timed_out`, writing a `job_logs` entry that records the forced transition.

The sweep runs in-process via `src/lib/jobs/scheduler.ts`. `setInterval` isn't
viable on serverless (the function freezes between requests), so it's
triggered solely by **cold start**: `src/instrumentation.ts` fires
`runSchedulerIfDue` once per Node runtime init, fire-and-forget so cold-start
latency is unaffected. It is deliberately *not* triggered opportunistically on
every job dispatch — that multiplied DB connections made under load and made
production connection timeouts more likely for no real benefit.

The cold-start trigger is skipped entirely when `VERCEL_ENV === 'preview'`
(checked before `createDb()` is even called, in both `instrumentation.ts` and
as defense-in-depth inside `runSchedulerIfDue` itself). Preview deployments
get ephemeral, per-PR Neon branches that are created/torn down by
`.github/workflows/preview-db.yml`; a cold start hitting a branch that's
mid-spinup or already deleted surfaces as password-auth or connection-timeout
errors that have nothing to do with real stuck jobs.

The trigger is gated by a 24h DB window: `runSchedulerIfDue` queries the
most recent `stuck_cleanup` job row and skips if one was created within the
last 24h. Each sweep that actually runs is itself inserted as a
`stuck_cleanup` job, producing standard `job_logs` transitions
(`pending → running → completed`) for observability. A per-process
`inFlight` promise coalesces concurrent triggers.

Trade-offs:

- If the deployment has no cold starts for 24h, no sweep runs from the
  in-app trigger. Use the manual `GET /api/cron/cleanup-jobs` route (below)
  for long warm stretches with no cold starts.
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

### Workforce run liveness

A Workforce run that stops reporting progress for 30 minutes is marked failed,
so a stuck run can't block the queue. A run interrupted mid-way retries from its
last checkpoint.

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

### Company voting (Investment Committee rounds)

Every company detail surface — the full page (`/companies/<id>` and
`/pipeline/<dealId>`) and the `CompanyDetailDialog` — carries a **Voting** tab
(`src/components/pipeline/voting/CompanyVotingTab.tsx`, deep-linkable as
`?tab=voting`). It runs an Investment-Committee style round on one company.

**Data model.** `company_vote_sessions` holds one row per round (initiator,
deadline, the days/hours the initiator picked, status, and the post-conclusion
`ai_*` synthesis columns). `company_vote_ballots` holds one row per selected
voter (`choice`, `body_html`, `status`, `submitted_at`, `auto_submitted`),
unique on `(vote_session_id, voter_id)`. A **partial unique index**
(`uq_company_vote_sessions_one_active` on `company_id WHERE status = 'active'`)
is what guarantees at most one open round per company — two racing "Start Vote"
clicks cannot both win.

**Lifecycle** (all rules enforced in `CompanyVoteService`, and restated for
users by `VotingRules.tsx`):

1. **Start.** The initiator multi-selects voters (workspace members only) and a
   duration in days + hours. Ballot rows are created up-front, so "who still
   owes a vote" is a plain query rather than a set difference.
2. **Invite.** A `company_vote` job (`kind: 'invite'`) builds the Company Card
   deck **once** via `CompanyCardSlideService` + `exportElementsToPptx` and
   emails every voter an invitation carrying a deep link to the Voting tab, a
   link to the Company Card in-app (`?tab=overview`), and the deck itself as a
   `.pptx` attachment. A failed deck build degrades to an attachment-less
   invitation — the body then stops promising an attachment and points at the
   link instead — rather than dropping the email. This path uses
   `EmailService.sendVoteInvitationEmail` directly rather than the `send-email`
   queue, because a multi-MB attachment cannot ride a JSON queue payload.

   If the job cannot be dispatched at all (most often the `company_vote`
   `job_type` enum value missing because the migration has not been applied to
   that environment), `startVote` returns `invitationsQueued: false` and the
   route puts a `notice` on the response so the UI warns instead of reporting a
   clean success — otherwise "I never got the email" leaves no signal anywhere.
3. **The AI Opinion votes.** The company's standing AI Opinion counts as **one
   more voter** — it is in `voterCount`, in the tally, in the synthesis prompt
   and in the recap email. `startVote` calls `AiOpinionService.dispatch` when
   the company has no verdict yet (and *only* then — `dispatch` treats every
   call as a re-evaluation and would clear an existing opinion). Its ballot is
   derived at conclusion by `aiVerdictToVoteChoice` (`pass` → YES, `fail` → NO,
   anything else including "still generating" → INCONCLUSIVE) and snapshotted
   into `company_vote_sessions.ai_vote_choice`, so re-evaluating the company
   later cannot rewrite a recorded tally. It never maps to a HARD variant: the
   verdict expresses direction, not the conviction a human signals by choosing
   HARD.
4. **Vote.** The five choices are `HARD YES / YES / NO / INCONCLUSIVE / HARD NO`.
   The rationale is a TipTap WYSIWYG field (bold, italic, underline, font size,
   bullets, numbering, Tab indentation) stored as HTML and **sanitized
   server-side** by `sanitizeBallotHtml` (`src/lib/voting/html.ts`) on every
   save — it is rendered back into other users' browsers once the round closes.
   A voter can Save / Cancel (a purely local revert) freely; **Submit** locks the
   ballot and enqueues a `vote_submitted` confirmation email.
5. **Privacy.** While a round is `active`, `getState` returns only the viewer's
   own choice and rationale plus everyone's submitted/pending status. A non-voter
   sees "Voting in progress".
6. **Initiator controls.** *Cancel vote* abandons the round; *Send back
   submissions* flips every submitted ballot back to `draft` in one set-based
   UPDATE.
7. **Close.** The round concludes when the last ballot is submitted, or when the
   deadline passes — swept every 5 minutes by `GET /api/cron/close-votes`
   (`CRON_SECRET`-protected, like the other crons). That route **iterates every
   workspace** and calls `processDueSessions` with a per-workspace container:
   Vercel Cron carries no session, so `getActiveWorkspaceId()` would silently
   fall back to the default workspace and leave every other tenant's rounds open
   forever. Closing auto-submits stragglers (as picked if the voter had chosen,
   otherwise `INCONCLUSIVE`, always with `auto_submitted = true`), snapshots the
   company's standing AI Opinion onto the session, and queues a `company_vote`
   job (`kind: 'conclude'`).
8. **Recap + synthesis.** The conclusion job runs `generateVoteSynthesis`
   (`src/lib/voting/synthesis.ts` — structured output over the verbatim ballots)
   into `ai_synthesis` / `ai_key_positives` / `ai_key_concerns`, then enqueues a
   `vote_recap` email to the initiator and every voter (deduped). A synthesis
   failure is recorded on the session and does **not** block the recap.
9. **Results.** `VoteResults.tsx` renders the outcome pill + headline (`4–0
   FOR`, from the pure `tallyVotes` in `src/lib/voting/tally.ts`), the synthesis
   / key positives / key concerns / AI Opinion row, and every reviewer's
   verbatim rationale side by side. A **Vote again** button opens a fresh round.

**Unsaved drafts survive a tab switch.** Radix unmounts an inactive
`TabsContent`, so `BallotPanel` is destroyed the moment the user looks at
Overview. `ballotDraftStore.ts` mirrors the in-progress choice + rationale into
`sessionStorage` (keyed per round) and restores it on mount, so leaving the tab,
reloading, or reopening the dialog is non-destructive. The cache holds only work
the server has not accepted: it is cleared as soon as the ballot is saved,
cancelled or submitted, and is ignored entirely for a submitted ballot. It is a
convenience cache, never a source of truth.

**Concurrency.** Closing, cancelling and submitting all race each other (the
last submit vs. the deadline cron; an autosave vs. a submit), so the writes that
must happen exactly once are **compare-and-swap**, not read-then-write:
`updateSession(..., { expectedStatus: 'active' })` claims a round *before* any
side effect runs, and `updateBallot(..., { expectedStatus: 'draft' })` is what
actually enforces "a submitted vote can no longer be changed". The loser of
either CAS gets `null` back and surfaces a 409 instead of repeating the
side effects. `startVote` maps the partial unique index's `23505` onto that same
409, and rolls the session back by hand if the ballot insert fails — a session
with zero ballots would block every future round on the company.

**Endpoints.** `GET|POST|PATCH /api/companies/<id>/vote` (state / start /
`cancel`+`send_back`) and `PUT /api/companies/<id>/vote/ballot` (save or
submit). Every mutation returns the recomputed tab state, so the client never
follows a write with a second GET. Each mutating route passes the URL's company
id down so a body-supplied `sessionId` cannot reach another company's round.
Domain violations are typed `VoteRuleError`s carrying the HTTP status the route
should map them to.

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

**Fund Ledger v2.** The Fund Management module is powered by Fund Ledger v2
across 12 `fl_*` tables and is exposed through `/api/fund-ledger/*`. Its append-only
entries are posted and reversed through workspace-scoped repositories and services;
monetary values stay decimal strings end to end to avoid floating-point loss.
The legacy v1 `fund_*` ledger tables (`fund_assets`, `fund_asset_transactions`,
`fund_asset_valuations`, `fund_asset_investor_stakes`, `fund_investor_stakes`,
`fund_investor_commitment_events`, `fund_valuations`) are dropped by migration
`20260911000002_drop_legacy_fund_v1_tables`; only the orphaned legacy
master-data tables `funds`, `holding_entities`, and `funding_sources` remain
from v1 (still in Postgres, no longer defined in `schema.ts`).

**Cash Positions and Forward-Only Cutover.** Cash is modeled as canonical portfolio positions
with `asset_kind='cash'` per currency. Rather than risky historical backfills, funds transition
via forward-only cutovers (`fl_fund_cash_cutovers`, activated through admin route `/api/auth/fund-cash-cutovers`).
- **Never-Both Invariant**: For dates on or after cutover where all transacted currencies are activated,
  the fund is cash-ledger active: FMV includes the served cash balance exactly once and zeroes out
  retained proceeds. Inactive funds or historical dates prior to cutover remain on the legacy retained
  proceeds path.
- **One Cutover Date Per Fund Invariant**: All currencies for a fund must share exactly one common `cutover_date`.
  Multi-currency activation must be executed in a single transactional batch. Batches containing different dates
  are rejected (`InvalidCutoverError`), and additions or retries with conflicting dates are rejected
  (`CutoverConflictError`); identical retries remain idempotent. Persisted staggered rows are defensively
  treated as invalid/inactive (legacy incomplete) rather than picking an arbitrary date.
- **Strict Zero-Opening Invariant**: `zero_opening=true` must have no opening entry (`opening_ledger_entry_id` omitted)
  and requires the canonical cash-position balance at the cutover boundary (including all same-day activity) to equal
  zero, verified via `sumDeltasByPositionIds`. A non-zero opening balance requires `zero_opening=false` and an explicit
  non-zero opening entry (`sub_type='opening_balance'`); mixed or ambiguous forms are rejected.
- **DPI & Valuation Invariant**: Cash positions are valued at par (`cash_par`), excluded from holding
  counts, and excluded from realized distribution sums (`distributed`, `distributed_capital`, DPI).
- **FX Boundary**: Cash balances are tracked and exposed per-currency. A single reporting-currency
  total is provided only when all active balances match the fund base currency; multi-currency balances
  without exchange rates set `fx_status='pending_fx'` without nominal summation across currencies.
- **Null-Propagating History**: Aggregate quarterly history preserves explicit unavailability: if any included fund
  has an explicit null FMV/TVPI value for a quarter (such as active `pending_fx`), the aggregate FMV/TVPI and derived
  growth/delta for that quarter are null/unavailable—never zero or partial totals presented as complete.

**Multilingual asset names.** Original investments are often recorded under a
non-English name, so an asset carries both its recorded name
(`fl_assets.name`) and an optional English rendering
(`fl_assets.english_name`). Both are editable, and the English name can also be
entered upfront in the Add Asset dialog. Wherever an asset is listed, `getAssetDisplayName`
renders the recorded name with the English name in brackets — `凱羅斯半導體 (Kairos Semiconductor)` —
falling back to the plain name when no English name is set. `legal_name` remains separate: the full
registered legal name.

The Asset tab's right-most **AI Opinion** column (MB-470) mirrors the
pipeline's AI Opinion feature: clicking "Analyze AI Opinion" (or
"Re-evaluate") POSTs `fundAssetId` to `/api/fund-ledger/ai-opinion`
(`FundAiOpinionService.dispatch`), which enqueues a HIGH-effort (Opus) AI
Workforce run via the same `enqueueAgentRun` queue the pipeline uses. The run
reviews the holding's metrics (inlined into the instruction) plus `web_search`
context, then calls the `save_fund_ai_opinion` tool to write a firm
**buy / hold / sell** verdict + ≤50-word rationale onto the asset's
latest valuation (`ai_opinion_verdict` / `ai_opinion_summary` / `ai_opinion_status` /
`ai_opinion_updated_at`). There is no SSE stream for funds — while any holding
is `ai_opinion_status='processing'`, `FundManagement.tsx` polls
`getPortfolio()` every 4s and stops once no holding is left processing.

Funds, positions, and their ledgers are backed by the Fund Ledger API
(`/api/fund-ledger/*` → `FlLedgerService` / `FlPositionService` /
`FlBalanceService` / `FlPortfolioService`). **Investors** and **Funding Sources** are
persisted too (`fl_investors`, `fl_funding_sources`). The Add
Asset drawer picks an entity + source from these lists. The **By Investment
Entity** tab is an LP pro-rata view backed by positions (`/api/fund-ledger/positions`). The **By Source of Fund** tab groups each fund's live holdings by
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
  stake breakdown, `✎ stakes` inline editor) backed by `fl_positions`
  (`/api/fund-ledger/positions`).
- `SourceTable.tsx` — the "By Source of Fund" rollup, grouping the live holdings
  by `funding_source` (with an "Others" bucket); both tabs have an inline
  "Add …" header button.

The flag prop `showFundManagement` is threaded through every page and view
alongside `showCompanyGraph` so the nav item renders consistently.

### Ledger

The **Ledger** page (`/ledger`, nav item gated by the `LEDGER_ENABLED` feature
flag / `ledgerEnabled` in `src/lib/flags.ts`) is the row-level view of Fund
Ledger v2: every posted movement against the position that holds it, rather
than the roll-ups Fund Management shows. It lists entries flat or grouped by
position, expands any row into its full detail (flow strip, funding split,
provenance, the far leg of a transfer), and can post new entries and reverse
existing events.

**Two rules the page is built around.**

1. *Every sign is read from the position holder.* An investor's capital call is
   negative cash for them; the fund's side of the same movement is the same
   number with the sign flipped. Distributions, redemptions, sells and income
   are all positive cash to the holder — which is what lets DPI and IRR be
   summed from `cash_delta`.
2. *Nothing is stored as a balance.* Commitment, paid-in capital, units,
   blended price and net cash are all counted up from the rows on each redraw.
   The date control therefore sets two different things: **To** is the as-of
   date, and balances always count from inception up to it; **From** only
   narrows which rows are listed and which cash flows the metrics total. The
   right-click quick filters behave the same way — they change what you are
   looking at, never what a position is worth.

**No new endpoints.** The whole page is served by one
`GET /api/fund-ledger/portfolio` (the read model already arrives with holders,
instruments, events and funding allocations joined), and writes go through the
existing `POST /api/fund-ledger/events`, `PATCH`/`DELETE
/api/fund-ledger/events/:id` and `POST /api/fund-ledger/positions`. Fetching
per as-of date would be a request per keystroke on the date picker; fetching
per row would be the per-asset fan-out that previously exhausted the connection
pool.

**Editing and deleting.** Expanding a row opens an editor for the whole event.
It is event-level because `FlLedgerService.replaceEvent` deletes the event and
re-posts it under the same id — so a transfer's two legs are shown and saved
together, and the entry ids change on save. Two things the re-post would
otherwise destroy are handled explicitly: an entry-level funding split is sent
back verbatim (and its cash field locked, since the split has to add up to the
cash), and an event whose rows carry `is_reversal` is blocked from editing
entirely, because `postEvent` refuses that flag as input and saving would
quietly clear it.

Note that `FlLedgerService.reverseEvent` **is** `deleteEvent`: it removes the
event, its entries and their allocations, and posts no mirroring rows. The row
menu therefore says "Delete this event" and the dialog says the history will
not reproduce — the append-only reversal language the original ledger design
used does not describe this backend.

**Shared model** (`src/lib/fundLedger/`) — pure, UI-free and server-safe, so the
page and the copilot's `query_ledger_entries` tool derive identical numbers
from identical rows:

- `entryTypes.ts` — the entry-type matrix as data, mirroring the CHECK-style
  validation in `FlLedgerService.validateEntryDeltas`. Drives the Entry rules
  dialog and the posting form's field gating.
- `derive.ts` — resolves positions to holder/instrument/source, derives From and
  To, rolls a position up (commitment, undrawn, invested, units, blended price,
  net cash), and checks that transfer legs cancel.
- `filters.ts` / `query.ts` — the right-click filter engine and the three
  widening scopes (as-of → window → listed) that keep balances and listings
  independent.
- `postDraft.ts` — the posting form's model: the rows a draft would write and
  the `PostEventInput` it becomes. Signs come from the type, never the keyboard.
- `editDraft.ts` — the in-place event editor's model: the signed deltas as
  stored, validated against the same matrix, plus the split-preservation and
  reversal-blocking rules above.
- `format.ts` — display formatting, exact via `flDecimal` where it matters.

**View** (`src/views/Ledger.tsx` + `src/views/ledger/`) follows the
fund-management convention: co-located single-responsibility modules, its own
`glossary.ts`, and shared primitives in `parts.tsx`. The dotted-term tooltip
itself now lives in `@/components/common/GlossaryTerm` so each page can bind it
to its own vocabulary.

**`SheetTable`** (`src/components/sheet/`) is the reusable spreadsheet-style
table the page is built on: fixed pixel column widths behind a horizontal
scroll, sticky header, truncate/wrap switch, rows that expand into a full-width
detail panel or a nested section with its own column set, and a right-click
hook that hands the host the column and value under the cursor. It is
deliberately free of ledger/fund imports so other pages can drive it from a
different row type. Not to be confused with `@/components/table`
(`ManagedTable`), which solves the different problem of workspace-persisted
column reorder/hide/group for the browsable record tables.

## In-app feedback (MB-480)

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

## Data Navigator (RSS news lake)

A global, cross-workspace news lake ingested from a curated catalog of RSS
feeds across five categories (`expert_insights`, `market_assessment`,
`new_funding`, `ma_partnerships`, `industry_reports` —
`RSS_CATEGORIES` in `src/lib/db/schema.ts`). The checked-in catalog
(`data-pipeline/fixtures/rss-feeds.csv`) has 263 rows but only 256 distinct
`feed_url`s (6 duplicates); the import upsert is keyed on `feed_url`, so a
clean import reports **256 imported**, not 263.

- **Schema:** `rss` (pipeline-owned, no `workspace_id` anywhere — the catalog
  and the ingested news are shared by every workspace by design; migrations
  live in `data-pipeline/migrations`). `rss.feeds` is the runtime-editable
  catalog; `rss.items` holds metadata for every ingested item (plus the
  original *and* English text of anything translated); `rss.item_chunks`
  holds 1024-dim pgvector embeddings for the LLM-selected subset; `rss.ingest_runs`
  records each poll/enrich run's stats and error.
- **Ingest:** two scheduled Lambdas in `data-pipeline` (`data-pipeline/src/lambda/`) —
  `rss-poll` (`rate(30 minutes)`) conditional-GETs every `status = 'active'` feed,
  normalizes and inserts genuinely-new entries into `rss.items`, archives them as
  NDJSON to the S3 bronze bucket, and updates per-feed health; a feed retires
  itself to `dead` after **10** consecutive failures
  (`MAX_CONSECUTIVE_FAILURES` in `rssRepository.ts`) rather than waiting for a
  human to notice — the PoC found ~35% of a raw seed catalog was already
  rotten. `rss-enrich` (`rate(10 minutes)`) drains four bounded, sequentially-run
  queues: Haiku relevance classification (capped per category per UTC day),
  full-article extraction for selected items (3 attempts,
  `MAX_CONTENT_ATTEMPTS`), Haiku translation of non-English items (see below),
  and Bedrock Titan embeddings into `rss.item_chunks`.
  Both Lambdas are idempotent — status columns and the unique `item_hash` index
  make a crashed/re-run invocation a no-op rather than a duplicate.
- **Translation (non-English items).** The catalog spans several regions, so a
  real slice of the lake arrives in Japanese, Korean, German, Spanish and so
  on. The translate stage (`data-pipeline/src/handlers/rssTranslate.ts`) detects
  the language **locally** first — `rssLanguage.ts` is a dependency-free
  script-census + stopword heuristic — so the English majority never costs a
  model call; only what it flags goes to Haiku, one bounded plain-text call per
  field and per ~6 KB body chunk (JSON would let one `max_tokens` cutoff make a
  200 KB body unparseable). Results land in parallel `language` /
  `title_en` / `summary_en` / `content_text_en` columns: the original is
  **never** overwritten, because the reading pane offers a "display in original
  language" toggle. Three attempts (`MAX_TRANSLATION_ATTEMPTS`), then the item
  goes `failed` and stays fully usable in its own language.
  - **Two limits, not one.** The stage examines `DETECT_LIMIT` (200) rows per
    run but translates at most `TRANSLATE_LIMIT` (15), settling every English
    row in a single batched `UPDATE`. Keeping them separate is load-bearing:
    embedding waits on translation resolving, so if English rows counted
    against the model budget a backlog of them would starve the embed queue
    with work that never needed a model. The overflow is reported as
    `translation_deferred` rather than silently dropped. For the same reason,
    the migration backfills every already-embedded row to `not_needed` — the
    default `'none'` would otherwise make the whole historical corpus
    simultaneously unembeddable and queued for re-examination.
  - **Order matters:** embedding is gated on `translation_status` having
    resolved, because *both* halves of hybrid search are English (an English
    query embedding, and a trigram `ILIKE` over English words) — indexing a
    Japanese body would leave the item unreachable by any query a user would
    actually type. `runEmbedding` therefore embeds `title_en`/`content_text_en`
    whenever they exist. Same reason the lexical half now ILIKEs `title_en`
    alongside `title` (with a matching `gin_trgm_ops` index).
  - **Surfaces:** the news list always renders the English headline plus a
    language badge — a foreign headline is unreadable to someone scanning the
    feed — while the reading pane adds the per-article toggle and a
    machine-translation notice. `search_news` marks a translated hit in its
    output so the agent doesn't quote machine copy as verbatim. The single
    shared answer to "which text do I show" lives in
    `src/views/dataNavigator/translation.ts`.
  - **Detection bias:** the heuristic answers "English" when unsure (including
    for text below `MIN_WORDS_FOR_DETECTION`, e.g. a bare headline on an item
    whose content fetch failed). A false "English" costs a slightly-awkward
    card; a false "non-English" wastes a call and round-trips real English
    prose through a translator.
- **Volume control:** `RSS_DAILY_CAP_PER_CATEGORY` (default **25**) caps
  selected items per category per UTC day, shared across every batch in a run
  so a large backlog can't blow through the cap by splitting into batches.
- **Bedrock region.** Bedrock is not offered in `ap-southeast-3`, where the
  pipeline Lambdas run, so embedding calls use `BEDROCK_REGION` (default
  `ap-southeast-2`, see `src/lib/bedrock.ts`) and must **never** fall back to
  `AWS_REGION` — that reserved Lambda env var is `ap-southeast-3` and silently
  falling back to it would break every embed call.
- **Bedrock IAM — two sides, not one.** The pipeline Lambdas embed article
  chunks and get `bedrock:InvokeModel` from
  `data-pipeline/terraform/pipeline-compute/iam.tf`. The **app** separately
  embeds the *search query* in-process — `createContainer` and the
  `search_news` tool each build a `BedrockEmbeddingClient` — under the
  `mna-app` IAM user, which gets `mna-app-bedrock-invoke` from
  `terraform/iam`. Miss the app-side grant and
  `DataNavigatorService.vectorHalf` swallows the `AccessDenied`, logs
  `[data-navigator] vector search unavailable:`, and returns `[]`, so hybrid
  search silently degrades to trigram-only. Both policies scope to a single
  model ARN, so `BEDROCK_REGION` / `BEDROCK_EMBEDDING_MODEL` must match the
  `bedrock_region` / `bedrock_embedding_model` Terraform vars on both sides.
  Model access for Titan Embed v2 must also be enabled in the Bedrock console
  for that region — IAM alone is not enough.
- **Serving:** `DataNavigatorService` → `/api/data-navigator/*`
  (`filters`, `items`, `items/[id]`, `search`) → the `/data-navigator` page,
  gated by the `DATA_NAVIGATOR_ENABLED` runtime feature toggle (see
  [Runtime feature toggles](#runtime-feature-toggles) — **defaults to
  disabled**, so the feature ships dark until a superadmin turns it on per
  workspace).
- **RAG:** the `search_news` agent tool runs hybrid search (pgvector cosine
  similarity + trigram `ILIKE`, merged and re-ranked in
  `DataNavigatorService.searchNews`) over the lake. It's registered on the
  base `tools` list, so it reaches the **`mna` chat, AI Workforce, and
  `combined`** Copilot flavors; the **`investment`** and **`vc`** flavors
  enumerate their own tool lists in `src/lib/agents/analysis/tools/index.ts`
  and do **not** include it.
- **Feed admin:** `X-Api-Secret`-gated routes under `/api/auth/rss-feeds`
  (list/create, `/:id`, `/import`) — see [Admin routes](#admin-routes-apiauth).
  Bulk-import the checked-in catalog with `pnpm rss:import-feeds`.

**Build note.** `canvas` sits in the esbuild `external` list
(`data-pipeline/scripts/build.ts`) solely because `rss-enrich`'s article
extractor (`@extractus/article-extractor`) pulls in `linkedom`, which
`require`s `canvas` inside a try/catch and falls back to a stub when it's
absent — esbuild can't bundle the native `.node` binary anyway, and
`rss-enrich` only strips/parses HTML text, never renders to a real canvas.

**Local invoke:**

```bash
pnpm --filter data-pipeline invoke rssPoll '{}'
pnpm --filter data-pipeline invoke rssEnrich '{}'
```

(Both handler names must be listed in the `HANDLERS` allowlist in
`data-pipeline/scripts/invoke-local.ts` for `invoke <name>` to resolve them.)

**Not yet deployed.** The Terraform for the RSS bronze bucket
(`terraform/s3-rss`) and the two Lambda schedules + Bedrock IAM policy
(`data-pipeline/terraform/pipeline-compute`) is written and passes `fmt`/`validate`,
but has never been `apply`'d to any environment, and no staging feed import
has been run. Separately, the app-side Bedrock policy in `terraform/iam` is an
**incremental** change to a module that is already live in every environment
(`mna-app` is the identity Vercel already uses for S3/SES/RDS) — it needs a
plain `make init-<env> && terraform apply` per account, not a first-time
stand-up. Treat the subsystem as code-complete but operationally
unproven until that happens.

Design: `docs/superpowers/specs/2026-09-02-data-navigator-rss-lake-design.md`.
