# Async jobs

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

## Stuck-job cleanup scheduler

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

## Workforce run liveness

A Workforce run that stops reporting progress for 30 minutes is marked failed,
so a stuck run can't block the queue. A run interrupted mid-way retries from its
last checkpoint.

## Scheduled deal resurfacing

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

## Company Context (the Context tab)

Every company detail surface — the full page (`/companies/<id>` and
`/pipeline/<dealId>`) and the `CompanyDetailDialog` — carries a **Context** tab
(deep-linkable as `?tab=context`) holding two things, in this order:

1. **Context** — `companies.context`, a free-form markdown document the deal team
   writes about the company. Rendered with `MarkdownRenderer`; "Edit" swaps in a
   source textarea with a **Save Context** button underneath. Both surfaces render
   the same `src/components/pipeline/CompanyContextCard.tsx`, which PATCHes
   `/api/companies` through `updateCompany` so the two tabs cannot drift apart.
   The tab sits immediately after Overview on both surfaces.
2. **Notes** — the `deal_notes` timeline, which used to live at the bottom of the
   Attachments tab. It moved here because it answers the same question the
   context does ("what do we know about this that no column holds?"), just dated.

The point of the field is that **every AI surface reads it**, so knowledge with no
column to live in still reaches the model:

- **AI Opinion** — `AiOpinionService.dispatch` inlines the context into the run's
  instruction (capped, with a pointer to `get_company_details` when it overruns)
  and tells the run to weigh it explicitly and to flag any conflict with what it
  finds externally.
- **Company Card / slide generation** — `buildCompanyContext` in
  `CompanySlides.tsx` (per-slide prompts), `buildCompanyContext` in
  `jobs/handlers/companyAnalysis.ts` (the AI Company Card the slides draw from),
  and `buildPresentationCompanyContext` in `pptx/companyContext.ts` (emailed
  presentation specs) all carry it.

Every one of those prompt paths clips the document through
`clipCompanyContext` (`src/lib/companyContextPrompt.ts`). The field is
user-authored markdown with no length bound — a pasted call transcript would
otherwise swamp the prompt it was meant to inform — so the cap lives in one
place rather than per caller, and callers that want to say "there is more" read
the `truncated` flag (the AI Opinion instruction uses it to point the run at
`get_company_details`).
- **Agent read tools** — `get_company_details` prints it in full, followed by a
  **Notes** section carrying the same `deal_notes` timeline the tab shows beside
  it. Notes are user-authored and unbounded too, so that section reads only the
  15 newest rows (`findByDealId(id, limit)`, with `countByDealId` supplying the
  true total), clips each body through `clipCompanyContext` at 1.5k characters,
  stops once those bodies total 6k, and says how many older notes it left out
  — one chatty company must not crowd the financials out of the reply;
  `query_companies` takes `include_context` to append a truncated Context column;
  and `companyFilterShape` gains `context` (partial match) + `has_context`, so
  every tool sharing that vocabulary can filter on it. `search_term` matches the
  context column too.
- **Agent writes** — `add_company` takes a `context` argument (and now persists
  its `note` to the company's notes timeline instead of only echoing it), so a
  company added from chat or the workforce arrives with its background already
  recorded. `update_company_details` can edit `context`; writing it replaces the
  whole document, so the tool description tells the agent to read the current
  text first.

## `add_company` covers the whole intake

`add_company` accepts essentially the whole editable record, so an intake lands
complete in one call instead of a bare row the workforce has to enrich
afterwards with `update_company_details`. Two parts of it are worth knowing:

**Either name identifies the company.** `target` (the real name) and
`project_name` (the internal codename) are separate columns and both are
optional — the tool only requires *at least one*. A teaser that arrives as
"Project Sunrise" with no disclosed company name is added under the codename
alone rather than refused or given an invented target; `companyDisplayTitle`
already renders a target-less record as `[Project Sunrise]`. The duplicate guard
fuzzy-matches **every** name supplied, not just the target, because an existing
record may carry only one of the two for the same deal.

**People columns are resolved from names.** `deal_sponsor`, `deal_captain` and
`entered_by` are uuid FKs to `users.id`, but an agent only ever has a person's
name. The tool reads the workspace's members **once** (`findAllInWorkspace` —
the same list every user picker in the app offers) and matches name, email or id
case-insensitively in memory, however many of the three were passed; a per-field
lookup would be a fan-out on a table every intake touches. A name matching
nobody, or matching two members, is a **refusal before the insert** — not a
company row with a silently wrong or missing owner — and the error names the
real options so the agent can retry with an email. `banker`, `banker_source`,
`advisor` and `originator` are deliberately *not* in this group: those are free
text, not platform users.

## Company voting (Investment Committee rounds)

Every company detail surface — the full page (`/companies/<id>` and
`/pipeline/<dealId>`) and the `CompanyDetailDialog` — carries a **Voting** tab
(`src/components/pipeline/voting/CompanyVotingTab.tsx`, deep-linkable as
`?tab=voting`). It runs an Investment-Committee style round on one company.

**Data model.** `company_vote_sessions` holds one row per round (initiator,
deadline, status, and the post-conclusion `ai_*` synthesis columns). Its
`duration_days` / `duration_hours` columns are **legacy** — rounds used to be
opened for "X days Y hours"; the initiator now picks an absolute deadline, so
nothing writes them and they default to 0 on new rows. `company_vote_ballots` holds one row per selected
voter (`choice`, `body_html`, `status`, `submitted_at`, `auto_submitted`),
unique on `(vote_session_id, voter_id)`. A **partial unique index**
(`uq_company_vote_sessions_one_active` on `company_id WHERE status = 'active'`)
is what guarantees at most one open round per company — two racing "Start Vote"
clicks cannot both win.

**Lifecycle** (all rules enforced in `CompanyVoteService`, and restated for
users by `VotingRules.tsx`):

1. **Start.** The initiator multi-selects voters (workspace members only) and
   picks the **date and time** the round closes — a calendar popover plus a time
   field, combined in the browser's local zone and sent as an absolute ISO
   instant. `parseDeadline` (`src/lib/voting/deadline.ts`) re-validates it
   server-side: at least 15 minutes out (an invitation email has to land first)
   and at most a year. The server stores the instant verbatim and never
   re-derives it, so the wall-clock deadline the picker showed is exactly what
   the cron sweeps on. Ballot rows are created up-front, so "who still owes a
   vote" is a plain query rather than a set difference.
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

   **The initiator is the exception.** For a round *they* started and that is
   still open, `getState` returns `visibility: 'live_results'` — every ballot's
   choice and rationale, and a running tally — so the organizer can read the
   room while it fills. It is decided server-side off `session.initiated_by`;
   the client only reads the flag. Three things stay honest in that view: the
   tally counts **submitted ballots only** (a draft is not a vote), the AI
   Opinion shows where its standing verdict currently points but is *not* folded
   into the tally (its ballot is cast at conclusion), and the synthesis is
   absent because it is not written until the round closes. A `cancelled`
   round's drafts stay private even from the initiator.
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
   The same component renders the initiator's live view (`live` prop) — one
   layout for both, so the organizer reads an open round in exactly the shape it
   will be recorded in. In `live` mode it swaps "Data as of" for the submitted
   count + deadline, adds a LIVE pill, marks unsubmitted ballots as drafts,
   replaces the synthesis blocks with "written when the round closes", and drops
   the **Vote again** button.

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

## Fund Management

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
across 14 `fl_*` tables and is exposed through `/api/fund-ledger/*`. Its append-only
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

**Ownership and corporate actions (MB-567).** Our ownership % in a company is
tracked as its own history, separate from both the ledger (cash) and
valuations (worth). A corporate action is recorded once on the company asset
and changes the stake of every one of our positions in it, across all our
funds. `fl_corporate_actions` holds the action — `action_type` is `funding_round`,
`opening_stake` or `other`, with date and label, and for a funding round its
currency, pre-money and round size — and `fl_ownership_changes`
holds, per position, the stake before, any follow-on amount, the stake after
and an optional manual override with its remark. `FlCorporateActionService`
(`/api/fund-ledger/assets/:id/corporate-actions`, `/api/fund-ledger/corporate-actions/:id`)
computes a funding round with the pure calculator in
`src/lib/fundLedger/fundingRound.ts` (stake × pre-money + follow-on, over
post-money); an opening stake (starting from 0%) and other actions take the
stake after as entered. A position's current stake is the stake after of the
latest action it took part in, falling back to a quarterly mark's
`shareholding_pct` only while it has no history. Corporate actions write
neither ledger entries nor `fl_valuations` marks, so invested capital, realized
proceeds, contributions and market value cannot move. A funding round never
posts the follow-on cash either, only warns when no matching `buy` entry exists
within 30 days. Editing or deleting an action replaces or removes its own rows;
later actions are not recomputed but are flagged stale when their starting
stake no longer matches what the previous action left (an opening stake starts
a new chain). Fund-of-funds stakes are rejected. The Ownership tab on an equity
holding shows current ownership and the history, takes funding-round amounts
in millions, comma-groups amounts as they are typed, names each holder with its
English name when it has one, and fixes the round's currency to the workspace
currency (shown read-only). It sits behind the opt-in `CORPORATE_ACTIONS_ENABLED` funds setting:
while the setting is off the tab is still listed but shows a "turned off"
notice and loads nothing, and the API returns 404.

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
- `FundSummaryTable.tsx` + `HoldingDetail.tsx` — the "By fund" table (expandable funds →
  holdings → tabbed detail panel: Performance, Company & legal, Business, Share
  economics, Transactions, Historical value; the FoF variant swaps in a Capital
  account tab). The current share price on Share economics is editable and
  recomputes MOIC / IRR / return live.
- `EntitySummaryTable.tsx` — the "By Investment Entity" LP pro-rata rollup (per-fund
  stake breakdown, `✎ stakes` inline editor) backed by `fl_positions`
  (`/api/fund-ledger/positions`).
- `SourceSummaryTable.tsx` — the "By Source of Fund" rollup, grouping the live holdings
  by `funding_source` (with an "Others" bucket); both tabs have an inline
  "Add …" header button.

The flag prop `showFundManagement` is threaded through every page and view
alongside `showCompanyGraph` so the nav item renders consistently.

## Ledger

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
