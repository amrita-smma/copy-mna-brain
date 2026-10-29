# Tech Debt

A running log of known, accepted shortcuts and the conditions under which they
should be paid down. Each entry: what the shortcut is, why we took it, the
trigger to revisit, and the intended fix.

---

## `ai_workforce_queue.failure_seen_at` is a dead column

**Area:** `src/lib/db/schema.ts` (`aiWorkforceQueue.failure_seen_at`).

**What it is:** the Workforce nav item's red chip used to count failures nobody
had opened, stamped by `GET /api/workforce-queue/[id]`. It now counts failures
from the last 24 hours instead, so nothing reads or writes the column. Its
partial index was dropped in
`drizzle/migrations/20261029000000_workforce_queue_history_index.sql`; the
column itself was left in place.

**Why we took it:** dropping a column is the destructive half of a two-phase
migration (`.claude/rules/drizzle-migrations.md`); it has to wait until no
deployed build selects it.

**Trigger to revisit:** once the build that stopped using it has been live in
production for a release cycle.

**Intended fix:** a migration that drops the column, and remove it from the
schema.

---

## `job_type` is repaired after every migrate run

**Area:** `scripts/migrate.ts`, `scripts/reconcileEnums.ts`,
`data-pipeline/migrations/20260724130200_drop_legacy_email_pipeline.sql`.

**What it is:** that pipeline migration drops and recreates `public.job_type`
from a literal list of seven values. The migrate script applies the whole app
folder before the whole pipeline folder, so on a database built from scratch
(a fresh local stack, a reset preview branch, a new environment) the rebuild
runs after the app's later migrations and discards every job type they added
— `deal_document_processing`, `company_vote`, `pending_auto_scan`,
`chat_message_embedding`, the `bot_*` types — while their migration rows stay
recorded. Environments migrated incrementally over time never noticed. The
repair is a step at the end of `scripts/migrate.ts` that re-adds whatever
`src/lib/db/schema.ts` lists; it is idempotent and a no-op elsewhere.

**Why we took it:** applied migrations are never edited
(`.claude/rules/drizzle-migrations.md`), and a new migration in either folder
cannot fix the ordering: an app migration would still run before the rebuild
on a fresh database.

**Trigger to revisit:** when the migrations are squashed into a baseline, or
when the two folders are merged into one ordered sequence.

**Intended fix:** a single ordered migration history, with the enum rebuild
expressed against the live label list. Then drop the reconcile step.

---

## Approval (HITL) card outcomes live only in the browser that clicked

**Area:** `src/components/chat/ApprovalCardShell.tsx` (`useApprovalResolution`)
and every card on it — `BotChangeApprovalCard`, `BotRoutineApprovalCard`,
`InsightCreateApprovalCard`, `InsightEditApprovalCard`,
`InsightRefreshApprovalCard`, `OptionCard`, `ReportPlanCard`.

**What it is:** when the user approves or cancels a card, the outcome
("Created Atlas.", "Cancelled — nothing was changed.") is written to
`localStorage` under a per-approval key (`bot_change_resolved_<id>`,
`bot_routine_resolved_<id>`, …) and nowhere else. The transcript row that
carries the card is the agent's message with its encoded marker, which never
changes. So the same thread opened in another browser, on the phone, or after
clearing site data shows the card **pending again**: the buttons are live, and
a second Approve re-runs the action (a second bot, a second routine). The
state also never reaches the agent: a later turn cannot know whether the user
acted.

**Why we took it:** the first cards (insight approvals) needed a resolved
state without a schema change, and `localStorage` gave one in an afternoon.
Every later card copied the hook.

**Trigger to revisit:** the first report of a duplicate created from a card,
or the first feature that needs the agent to know a card's outcome (a bot
that asks "did you approve that?"), or the mobile app being used alongside
desktop by the same people — which is now.

**Intended fix:** record the resolution server-side, keyed by `approval_id`,
and read it with the thread: a small `approval_resolutions` table (workspace,
user, approval id, outcome, acted at) written by the route the card already
calls (bots, routines, insights) or by a dedicated `POST /api/approvals/:id`,
returned alongside the thread's history page so a reloaded transcript on any
device renders the card settled, and pushed over the bots' SSE stream
(`reply`-style event) so an open tab elsewhere settles at once. Then
`useApprovalResolution` reads the server state first and keeps
`localStorage` only as the optimistic flash. The marker payloads already carry
`approval_id`, so no transcript rewrite is needed.

---

## Copilot memory is per user, not per bot, and its retrieval is a first cut

**Area:** `src/lib/services/userMemoryService.ts`, `src/lib/memory/*`
(`client.ts`, `extract.ts`, `prompt.ts`, `recallQuery.ts`, `vectorStore.ts`),
`user_memories`.

**What it is:** a memory is a fact about the user, keyed by `user_id` only.
The workspace is stamped on the row as provenance and never used to filter;
no bot, agent or thread scope exists. So what the user tells Deal Scout is
recalled by every other bot and in every workspace, which is sometimes right
(preferences) and sometimes not (a mandate confided to one bot). Retrieval is
one automatic injection per turn — top 8 by mem0's blended score with its
default 0.1 threshold, queried by the current message (plus the previous user
turn when short), bounded by a 6 s budget and dropped silently on failure.
Writes go through a Haiku extraction gate, then mem0's own extraction pass,
then a word-overlap heuristic (`isOneOf`) that decides whether what mem0
wrote is still "our" fact. The vector store is our own Drizzle/pgvector
table with mem0's dedup comparing against at most 10 neighbours per add.

**Why we took it:** it ships the useful case — a bot that remembers the
user's focus and preferences — on infrastructure we already run, and the
bots branch fixed the parts that made it silently useless (an inverted
extractor example, drift deletion, single-message queries, no recall in
background turns). "Good enough" was the bar; "scalable and per bot" was not.

**What exists per bot:** the explicit notes a user asks a bot to keep
(`bot_user_memories`, `BotMemoryService`, `update_bot remember`) are scoped
per user per bot, so a standing request to one bot stays with that bot. That
covers the "remember X" case by construction; the inferred mem0 memory above
is still per user across every bot, and the two are not reconciled (a
preference said in passing lands in mem0, a preference asked for lands on
the bot).

**Trigger to revisit:** a user with hundreds of memories (recall quality and
the 10-neighbour dedup both degrade), a workspace where bots are deliberately
specialised and cross-talk of memories is wrong, a second recall consumer
(the Workforce), the first privacy question about a memory formed in one
workspace surfacing in another, or a user confused by the same preference
living in both stores.

**Intended fix, in order of value:** (1) scope — add `bot_id` (and honour
`workspace_id`) as optional filters with a per-bot setting for "private
memory" versus the user's shared memory, and read both layers on recall;
(2) evaluation — a small fixture of turns with expected memories and expected
recalls, run in CI, so the extractor prompt and the overlap heuristic can be
changed without guessing; (3) retrieval — a score threshold and a per-memory
decay/last-used stamp so stale notes fall out, and a recall tool the model
can call for "what do you remember about X" beyond the top 8; (4) write path
— replace the overlap heuristic with `infer: false` plus our own dedup by
similarity, so mem0 stores exactly the sentence we extracted; (5) scale —
index and partition `user_memories` by user, and measure the Bedrock embed
calls per turn (query, entities, dedup) before enabling memory for every
workforce run.

---

## Unused auto-scan queue columns and screening job types

**Area:** `companies.auto_scan_requested_at` / `companies.auto_scan_force`,
`job_type` values `pending_auto_scan` and `ai_screening`
(`src/lib/db/schema.ts`).

**What it is:** AI screening moved from the `jobs` table (a per-minute cron
draining `auto_scan_requested_at` marks into `pending_auto_scan` jobs, each
screening criterion as an `ai_screening` job) onto the AI Workforce queue. The
columns and enum values are no longer written but are still in the schema.
`JobService.mirrorTerminalJobToSideRecord` still handles legacy `ai_screening`
rows.

**Why we took it:** dropping columns needs a two-phase migration
(`.claude/rules/drizzle-migrations.md`), and Postgres enum values cannot be
removed in place.

**Trigger to revisit:** once no environment has an `ai_screening` or
`pending_auto_scan` job row younger than the stuck-job buffer.

**Fix:** drop the two columns and their partial index; leave the enum values.

---

## In-memory Levenshtein for ingest company dedup

**Area:** `src/lib/fuzzySearch.ts`, `CompanyService.findBestFuzzyMatch`
(`src/lib/services/companyService.ts`), wired into the Smart Files ingest
dedup gate in `src/lib/services/fileService.ts`.

**What it is:**
The ingest dedup gate matches an extracted company name against existing
companies in two passes:
1. A fast SQL substring match (`CompanyRepository.findByNameFuzzy`, `LIKE '%…%'`
   after stripping legal suffixes).
2. A Levenshtein fallback (`findBestFuzzyMatch`) that pulls **every** company's
   `id`/`target`/`project_name` via `findAllIdAndTarget()` and computes
   relative edit distance **in application memory** (threshold 0.3 → accept at
   ≥ 0.7 similarity).

So the fallback is `O(N)` per ingest call and re-fetches the whole company table
on every call, with no caching.

**Why we took it:**
- The Levenshtein path only fires when the cheap substring gate misses, so it is
  not on the hot path for most files.
- The extracted matcher (`bestFuzzyMatch`) is pure and preserves exact
  edit-distance ranking semantics, which is what we want for typo/OCR dedup.
- At the current scale (an M&A deal tracker — companies number in the thousands,
  not consumer scale) the cost is negligible and not worth a schema change yet.

**Current state of the DB (as of this entry):**
- No `pg_trgm` extension installed; only `uuid-ossp`.
- The only index on the name column is a plain **B-tree** `idx_companies_target`,
  which cannot serve a leading-wildcard `LIKE '%…%'` or fuzzy matching. The
  substring gate is therefore already a sequential scan in Postgres.

**Rough cost model (per fallback call):**

| Companies | Fetch + deserialize all rows | In-mem Levenshtein scan | Per-call total |
|-----------|------------------------------|-------------------------|----------------|
| 1k        | <1–3 ms                      | ~2–6 ms                 | negligible |
| 10k       | ~5–20 ms                     | ~20–60 ms               | fine |
| 50k       | ~30–100 ms (~5 MB)           | ~100–300 ms             | **yellow** |
| 100k      | ~100–250 ms (~10 MB)         | ~200–600 ms             | ~0.5–1 s → **red** |
| 1M        | multi-second (~100 MB, GC)   | 2–10 s                  | not viable |

The row fetch + JS object materialization + GC usually dominates over the
Levenshtein math (names are short, ~20 chars) once the table is large.

**Trigger to revisit:**
- Companies cross **~10k** (start planning), or
- **> ~50k** (migrate — per-call latency crosses ~0.5 s and grows linearly), or
- Ingest latency is observably dominated by dedup regardless of count.

Effective load is `N × ingest_rate × targets_per_file × fallback_hit_rate`.
Ingest here is human/email-driven (low QPS) and the fallback only fires on the
substring-miss path, so we may stay green/yellow well beyond these row counts.

**Intended fix (preferred → fallback):**
1. **Trigram prefilter + in-memory Levenshtein (sweet spot).**
   `CREATE EXTENSION pg_trgm` + a GIN trigram index on `target`/`project_name`.
   Replace `findAllIdAndTarget()` in `findBestFuzzyMatch` with a candidate query
   (`WHERE target % $name OR project_name % $name`) that returns ~10–200
   index-backed rows, then run the **existing** `bestFuzzyMatch` Levenshtein
   ranking on that small set. Fetch becomes sublinear; match semantics are
   unchanged. The pure `bestFuzzyMatch` function already accepts an arbitrary
   candidate list, so only the candidate query changes.
2. **Fully DB-side (only at millions of rows).**
   `ORDER BY target <-> $name LIMIT 1` (trigram distance) or a `similarity()`
   threshold entirely in SQL. Fastest at extreme scale but changes ranking
   semantics — trigram similarity ≠ edit distance (differs on short names and
   transpositions), so thresholds must be re-tuned.

**Notes / gotchas:**
- `levenshtein()` from `fuzzystrmatch` is **not indexable**, so exact Levenshtein
  cannot be pushed into an indexed query — indexed fuzzy matching means trigram.
  That is why option 1 (trigram to narrow, Levenshtein to rank) is preferred.
- A short-TTL in-memory cache of `findAllIdAndTarget()` is a cheaper stopgap for
  bursty uploads, but adds staleness risk; prefer the trigram prefilter.
- Names shorter than 5 chars are intentionally excluded from the Levenshtein
  fallback (relative-distance matching is too aggressive on short acronyms); the
  exact substring gate already handles those.

---

# Codebase audit — 2026-10-07

Entries below come from a structural audit of the repo. Measurements were taken
with a value-import graph (excluding `import type`, which erases at runtime) and
are reproducible from the commands noted in each entry. They are ordered by
impact on day-to-day development speed, not severity.

---

## CI enforces only unit tests

**Area:** `.github/workflows/ci.yml`, `package.json`, `data-pipeline/`.

**What it is:**
The PR workflow runs `pnpm test` and `pnpm arch:map:check` (generated architecture
inventory). Three gaps remain:

| Check | Script exists? | Runs on a PR? |
|-------|----------------|---------------|
| Unit tests (root) | yes | yes |
| Architecture code map | `pnpm arch:map:check` | yes |
| Lint | `pnpm lint` | **no** |
| Typecheck | **no script at all** | **no** |
| `data-pipeline` tests (25 files) | `pnpm --filter data-pipeline test` | **no** |

`eslint.config.mjs` was written specifically so `react-hooks/rules-of-hooks`
would catch a conditional-hook bug that had already shipped; its own comments
say so. That rule is set to `error` and nothing runs it on a PR.

There is no `tsc --noEmit` script in the root project. `data-pipeline` has one
(`pnpm --filter data-pipeline tsc`) but CI only runs its `build`.

**Why we took it:**
The workflow predates the lint config and the pipeline workspace; nobody went
back to widen it.

**Trigger to revisit:** now — this is the cheapest item in this document.

**Intended fix:**
Add a `typecheck` script (`tsc --noEmit`), then add `pnpm lint`,
`pnpm typecheck` and `pnpm --filter data-pipeline test` as steps in `ci.yml`.
Expect a backlog of pre-existing lint warnings on first run; land the steps with
`continue-on-error` only if the backlog blocks, and remove it within a sprint.

---

## `tsconfig.json` is not in strict mode, but `CLAUDE.md` says it is

**Area:** `tsconfig.json`, `.claude/CLAUDE.md`.

**What it is:**
`.claude/CLAUDE.md` instructs "Use Typescript Strict mode". The root tsconfig
sets `strict: false`, `strictNullChecks: false`, `noImplicitAny: false`,
`noUnusedLocals: false`, `noUnusedParameters: false`. `data-pipeline/tsconfig.json`
has `strict: true`.

`src/` currently holds 423 `as any` and 295 `: any` annotations.

**Why we took it:** the app predates the rule; flipping strict on a codebase
this size is a large mechanical change.

**Why it matters more than the usual strict-mode argument:** an agent reading
CLAUDE.md writes code assuming null-safety guarantees the compiler is not
providing. The documentation is actively misleading, which is worse than the
missing checks.

**Trigger to revisit:** immediately for the *documentation* half — either soften
the CLAUDE.md line to describe reality, or commit to the ratchet below.

**Intended fix:**
Ratchet per-directory rather than flipping the root flag. Enable
`strictNullChecks` first (highest bug-catch per unit of churn), starting with
`src/lib/repositories` and `src/lib/services`, which are already well tested.

---

## Runtime import cycle spanning 72 modules — largely resolved

**Area:** `src/lib/services/container.ts`, `src/lib/services/index.ts`,
`src/lib/jobs/handlers/*`, `src/lib/agents/analysis/tools/*`.

**What it is:**
A single strongly-connected component of 72 modules in the value-import graph:

```
container.ts → companyAnalysisService → workforce/index → workforce/runAgent
  → agents/analysis/index → agents/analysis/workforce
  → agents/analysis/tools/index → tools/query_companies → container.ts
```

18 agent tools under `src/lib/agents/analysis/tools/` import `createContainer`
from the `@/lib/services` barrel, which re-exports `container.ts`, which
constructs every service, several of which reach back into the agents.

**Measured cost** (module closure, value-imports only):

| Entry point | Modules | LOC |
|---|---:|---:|
| `repositories/companyRepository.ts` | 2 | 5,026 |
| `services/companyService.ts` | 94 | 21,144 |
| `services/index.ts` (the barrel) | **414** | **106,393** |
| `services/container.ts` | **414** | **105,778** |

170 of the 190 route handlers import the barrel, so **122 of 521 test files
(23%) load 400+ modules each**, against a median of 5. That cost is paid on every
vitest run, every pre-commit hook, and continuously by `tsserver`.

**This is not theoretical.** `src/lib/agents/analysis/flavors/lazyToolList.ts`
exists solely to work around it: a module-scope `[...tools]` throws
`ReferenceError: Cannot access '…' before initialization` at Next build time.
Read that file's header before touching agent tool lists.

**Edge-cut simulation** (no single cut fixes it — the knot has redundant paths):

| Change | Largest SCC | Tests >300 modules |
|---|---:|---:|
| baseline | 72 | 122 |
| any single edge | 71–72 | 121–122 |
| agents stop importing the `services` barrel | 55 | 108 |
| agents stop importing barrel **and** `container` | **18** | **74** |

**Paid down (2026-10-12).** Fixes 1 and 2 below landed:

- Every agent tool now resolves the container lazily inside its handler
  (`await import('@/lib/services/container')`); none imports `createContainer`
  at module scope.
- `src/lib/services/index.ts` no longer re-exports `./container`; routes (and
  `src/auth.ts`, server pages, scripts) import `createContainer` from
  `@/lib/services/container` directly, and tests mock that module instead of
  the barrel.

Re-measured with the same value-import method: largest SCC **60 → 18**
(the residual knot is services that import agents that import services, e.g.
`companyAnalysisService → agents/analysis → tools`), barrel closure
**424 → 377** modules. `lazyToolList.ts` and its header stay — the residual
cycle still makes a module-scope `[...tools]` unsafe at Next build time.

**Trigger to revisit (what's left):** at the next change to agent tool
registration, consider breaking the `services → agents` edges (an injected
agent-runner boundary) to dissolve the residual 18-module SCC.

**Remaining guidance:** prefer direct module imports over the `@/lib/services`
barrel in new code.

---

## `createContainer` eagerly constructs every service on every request — resolved

**Area:** `src/lib/services/container.ts`.

**Resolved (2026-10-12).** The intended fix landed as written: every repository
and service inside `createContainer` is wrapped in a memoizing `lazy(...)`
thunk and the returned object exposes them through getters, so a service (and
its dependency chain — including the Neo4j driver, which used to be created on
every call) is constructed on first property access. The `Container` interface
is unchanged and no call site moved; `container.test.ts` pins the laziness,
memoization, enumerable-keys and `fileService` setter-wiring behavior.

Watch for the one behavioral edge: spreading or iterating a container
(`{ ...container }`, `Object.values`) constructs everything — identical to the
old eager cost, but no longer free to do casually.

---

## God files concentrated in the highest-churn code

**Area:** several; see table.

**What it is:** churn × size, over the last 6 months (711 commits):

| File | Lines | Commits |
|---|---:|---:|
| `src/components/pipeline/CompanyDetailDialog.tsx` | 3,239 | 62 |
| `src/views/Dashboard.tsx` | 2,931 | 66 |
| `src/lib/db/schema.ts` | 4,489 (106 exports) | 87 |
| `src/views/Pipeline.tsx` | 2,075 | 64 |
| `src/lib/services/container.ts` | 659 | 63 |
| `src/lib/services/fundUpdateApplyService.ts` | 5,165 | — |

`CompanyDetailDialog.tsx` is the worst: a **single component function spanning
lines 440–3170** (~2,730 lines), 48 direct imports, 513-module closure. An agent
asked to change one tab must load the whole file.

`schema.ts` at 4,489 lines with 87 commits is a standing merge-conflict surface.

**Trigger to revisit:** next substantial feature in either file.

**Intended fix:** split `CompanyDetailDialog` per tab (highest value — it is the
#1 churn hotspot). Split `schema.ts` by domain (`schema/companies.ts`,
`schema/fundLedger.ts`, …) behind a re-export barrel.

There are also 13 UI↔view circular imports, e.g. a 7-file cycle around
`Pipeline.tsx ↔ InboundCompaniesTable.tsx ↔ OutboundCompaniesTable.tsx`.

---

## Dead code and tracked build artifacts

**Area:** repo-wide.

**What it is:**
- **25 orphan files** with zero importers: `src/views/AIDiscovery.tsx`,
  `src/views/Index.tsx`, `src/views/NotFound.tsx` (leftovers from a
  pre-App-Router SPA), and ~13 never-used shadcn components.
- **843 exported symbols never referenced in any other file**, across 316 files.
  Worst: `emailService.ts` (27), `schema.ts` (21), `dashboardActivityService.ts`
  (15), `googleVaultService.ts` (14). Much of this inflates the barrels in the
  import-cycle entry above.
- **10 modules imported only by their own tests** — `googleVaultService.ts`,
  `posthog-events.ts`, `posthog-heartbeat.ts`, `modelParams.ts` are tested but
  wired to nothing.
- **`pnpm db:seed:crm` is broken** — it points at `scripts/seed-crm.ts`, which no
  longer exists.
- **Tracked build artifacts:** `build.log` (37KB, last touched 9 months ago, and
  `*.log` is already in `.gitignore`), `.vercel/project.json`.
- `src/lib/changelog.data.ts` — 6,774 lines, 119 commits in 6 months,
  CI-generated and ESLint-ignored, but still inside `tsconfig.json`'s `include`.

**Why we took it:** no owner; deleting unused exports is unrewarding work that
never blocks a release.

**Trigger to revisit:** opportunistically — delete dead code you encounter. The
broken seed script and the tracked artifacts are a 10-minute fix.

**Intended fix:** delete the orphans and artifacts; fix or remove
`db:seed:crm`; prune unused exports directory by directory, starting with the
service barrel.

---

## Copilot agents carry ~24.5k tokens of fixed context per turn

**Area:** `src/lib/agents/analysis/flavors/*`, `src/lib/agents/analysis/tools/*`,
`src/lib/agents/analysis/guides.ts`.

**What it is:** measured fixed overhead before the user types anything, `mna`
flavor (the default Copilot):

| Component | Chars | ~Tokens |
|---|---:|---:|
| System prompt (own text) | 6,460 | 1,615 |
| → interpolated shared guides | 41,372 | 10,343 |
| Tool descriptions (30 tools) | 40,239 | 10,060 |
| Tool zod schemas | 9,833 | 2,458 |
| **Total** | **97,904** | **~24,500** |

Worse on three flavors: `crowdfunding` ~15,190 prompt tokens,
`capital_markets` ~15,146, `investment_banking` ~14,987 — each plus ~12.5k of
tools. `workforce` carries the heaviest tool payload at ~17,655 tokens over 38
tools.

Breakdown of the waste:
- `MNA_PIPELINE_OPERATIONS_GUIDE` is 25,096 chars (~6,274 tokens) — 52% of the
  `mna` system prompt — and is interpolated into 5 of 8 flavors unconditionally.
  Across all flavors, shared guides are 55–86% of prompt text.
- `mna.ts` re-lists 16 tools as numbered prose descriptions that the tool
  schemas already carry. Duplicated tokens, and the prose list drifts from the
  real tool list independently.
- Two tools dominate the schema budget: `add_company` at 13,292 chars (~3,323
  tokens; 6,813 description + 6,479 schema) and `send_email` at 8,750 chars of
  description — together ~31% of the workforce tool payload.

**Why we took it:** the flavors grew by accretion, each adding guidance without
anyone measuring the assembled total.

**What is already correct and should not be "fixed":** prompt caching. The
fixed system prompt is its own content block with a `cache_control` breakpoint
(`buildSystemMessage` in `runtime.ts`), the per-turn context is appended as a
separate block at model-call time (`perTurnContextMiddleware`), the model also
binds `cache_control` on the last message via `withConfig` for the tool loop,
chat runs with context editing off (`buildBotTurnOverride`), and
`lazyToolList.ts` documents the real cycle it works around. The fixed prefix
(tools + prompt) is therefore cached at ~0.1x after the first call — the
remaining cost is the turn-one cache write plus 0.1x on every later call.
`AgentGraph.wrapEventStream` logs `cache_read` / `cache_write` per model call;
a run of calls with `cache_read=0` means something in the fixed prefix is
changing and this guarantee has regressed.

(Before the per-turn block was split out, the recalled memories and the
other-bots note were concatenated into the single system string, and the only
breakpoint sat on the last message — so every turn's first call re-read the
whole prefix uncached. Keep anything that varies per turn out of the fixed
block.)

**Trigger to revisit:** when adding the next flavor or the next ~5 tools.

**Done so far (2026-10-26):** the pipeline-operations guide is behind
progressive disclosure — `MNA_PIPELINE_OPERATIONS_SUMMARY` (routing rules) in
the prompt, the procedures served by `read_pipeline_operations_guide` — and
the `mna` prompt lost its numbered tool enumeration. Assembled prompt text,
before → after: `mna` 51.2k → 26.7k chars; `minority` 57.5k → 36.4k;
`crowdfunding` 61.8k → 40.7k; `investment_banking` 61.0k → 39.9k;
`capital_markets` 61.7k → 40.6k (roughly 6k tokens each). See
`docs/features/copilot-flavors.md` §"Pipeline operations are read on demand".

**Done (2026-10-27):** the other seven chat prompts dropped their numbered tool
enumerations too. Each kept its desk-specific framing — a short "The firm's own
data" paragraph (`investment_banking`, `capital_markets`), a "Two tool sets"
paragraph (`combined`), or lines folded into "How to Help Users" / the
principles (`minority`, `crowdfunding`, `investment`, `vc`) — and lost the
restated descriptions. Assembled prompt text, before → after: `investment`
27.0k → 22.5k chars; `combined` 27.4k → 23.0k; `vc` 27.9k → 24.6k; `minority`
36.4k → 32.3k; `crowdfunding` 40.7k → 37.4k; `investment_banking` 39.9k →
35.3k; `capital_markets` 40.6k → 36.2k (roughly 0.8–1.1k tokens each).
`index.test.ts` now asserts that no chat flavor enumerates its tools.

**Done (2026-10-27), tool search:** `send_email` (every chat list and the
workforce) and `add_company` (workforce) are sent with `defer_loading: true`
and found through Anthropic's tool-search server tool (`TOOL_SEARCH_TOOL` in
`tools/server_tools.ts`); every list that carries a deferred tool carries the
search tool (`tools/index.test.ts`), and every prompt that names them carries
`onDemandToolsGuide` (`guides.ts`). The blocker went into the local patch:
`patches/@langchain__anthropic@1.3.26.patch` now lets `tool_search_tool_result`
through both allowlists (`server_tools.test.ts` drives the patched module).
Measured on the `mna` list against the live API: the first call of a turn went
from 50.2k to 37.6k input tokens; `send_email` alone was 32.7k characters of
description + schema. The one hazard: a turn that *withholds* a deferred tool
(background bot turns withhold `send_email`) must still send a definition
under that name, because the history's `tool_search_tool_result` references
it — `withoutTools()` substitutes a refusing stand-in instead of dropping it.
See `docs/features/copilot-flavors.md` §"Tools loaded on demand".

**Done (2026-10-27), second deferral round:** six more tools load on demand —
the three insight proposals (`propose_report_plan`, `propose_insight_edit`,
`propose_insight_refresh`), `analyze_stalled_deals`, `get_task_progress` and
`read_relationship_graph` — another ~8.9k characters off every chat call's
loaded tool payload, and `get_company_stats` points at `query_companies` for
the filter vocabulary instead of inlining `COMPANY_FILTER_DOC` (the schema
still carries every field; the two tools' 8.5k-character schemas are the
bulk and cannot be shared). The tool-search server tool moved into the
shared base list `tools`, so every list built on it carries it once;
`investmentTools` and `vcTools` name it themselves; the sector agents get it
through `withToolSearch` in `composeSectorTools` and name their deferred tools
in `composeSectorRolePrompt` from the actual list. What stays loaded up front
is what nearly every turn uses: the company queries, the CRM lookups, the
searches, the approval cards, the handoff, navigation, the page context, the
insight reads.

**Done (2026-10-27), insight authoring rules on demand:** `INSIGHT_AUTHORING_GUIDE`
was 11.4k characters in every chat prompt, and most of it was HTML authoring
mechanics only needed on a turn that edits an insight. Those rules are now
`INSIGHT_EDIT_AUTHORING_RULES` on `propose_insight_edit`'s description — a
deferred tool's description is loaded only when the tool is found — and the
prompt keeps the 4.7k-character routing half. Same pattern is available for
any other guidance that only one deferred tool needs.

**Still to do (highest value first):**
1. Upgrade `@langchain/anthropic` past 1.6.0, whose allowlists carry the
   tool-search result types natively, and drop that part of the patch. Blocked
   on `@langchain/core` ^1.3 and `@anthropic-ai/sdk` ^0.129 (we pin ^1.1.45 /
   ^0.74), so it is a dependency-wide upgrade, not a bump.

---

## Where a chat turn's time still goes (audit 2026-10-27)

**Area:** `src/app/api/chat/route.ts`, `src/lib/agents/analysis/runtime.ts`,
`src/lib/bots/threadMiddleware.ts`, `src/lib/chat/effortRouter.ts`.

**What it is:** after the prompt and tool payload work above, a re-read of the
critical path from request to first streamed token, with what was measured
locally (real model, real prompt, stubbed tools; no production timing data
was available — the per-turn timeline the route logs, `[chat] … timeline`,
and `recordTurnTiming` on the Langfuse trace are where the real numbers are).

Done so far:

- The Sonnet tiers run with no up-front thinking
  (`EFFORT_TIERS[tier].thinking`, `between_tools`) — first visible text from
  a median ~10 s to ~1.5 s on `low` and ~7 s to ~1.7 s on `medium`, whole
  turns 20–35% shorter, the write/research scenarios unchanged.
- The setup round trips. The chain of sequential database round trips
  before the first model call was: session → default bot → the user's name
  (for the primary bot's title) → the thread → the bot list and bot memory →
  the turn claim → the checkpoint snapshot → the question insert → the
  checkpoint load inside the run. Now: the user's name and the thread are
  read together (`BotService.openThreadWith`; the thread is created only
  when the find is empty); the bot list is started before the thread open
  (`prepareMentionContext`) and the one user read is shared between the two
  presentations (the name cache holds the promise); the turn claim rides in
  the same round trip as the per-bot context reads; and the question row's
  id is chosen in the route so its insert is not awaited — it runs alongside
  the repairs and the stream start, the `after()` hook waits for it, and a
  failed insert stores the question under the same id at the end
  (`persistTurn`'s `question`). On a turn the router places, every database
  read before the router's answer is now hidden behind it; after it, two
  round trips remain (the snapshot and the run's own checkpoint load). On a
  turn with a hand-picked tier the serial chain is six round trips instead
  of nine or ten.
- The summariser spike. A permanent bot thread that crossed
  `BOT_SUMMARY_TRIGGER_TOKENS` (60k) paid the summary call — one Sonnet call
  over tens of thousands of tokens, ten seconds or more — in line, before
  that turn's first model call. Now the turn's `after()` hook (and a
  background bot turn's job) runs the same summarizer once the thread passes
  `BOT_SUMMARY_AHEAD_TOKENS` (48k), off the critical path and off the lock:
  the summary is computed from the thread as the hook read it and written
  under the lock only if the checkpoint has not moved
  (`AgentGraph.replaceMessagesIfAt`); a turn that started in between keeps
  the lock or moves the checkpoint and the write is dropped, to be tried
  again after that turn. The in-line trigger stays as the safety net.
- The checkpoint read's place in the chain. The thread's history
  (`getThreadSnapshot`, for the repairs and the zero-work check) was read
  through the tier's graph, so it could not start until the router had
  answered and the graph was resolved — the longest of the turn's reads on a
  long thread, serial after the longest pre-stream stage. Now
  `readThreadSnapshot` (`graphs.ts`) reads through whichever chat graph the
  process has already built — every chat graph shares the checkpointer and
  is compiled with no middleware, so they all read a thread identically —
  and the route starts it the moment the turn lock is held, so it rides
  behind the attachment upload, the router and the graph build. It is
  started under the lock on purpose: a turn that just released it is then
  fully written. The read itself is unchanged, and still one per turn.

Still on the table, in the order worth trying:

1. **The router's share, on the turns that still route.** `routeEffort`
   (Haiku, 1.5 s cap) starts at body time and, with the reads above now
   behind it, is the pre-stream stage on every routed Auto turn. Measured
   from a developer machine (36 calls, three message shapes): median
   ~0.7–0.9 s, p90 ~1.4 s, and the 1.5 s cap was hit on a run of calls — a
   turn that then falls back to `low` for a short question that needed
   `medium`. From Vercel's region expect less, but the same shape. Two
   things make it hard to shrink: `temperature` is rejected by Haiku 5.5
   (400), so a borderline question ("compare three targets and tell me
   which to promote") flips between `medium` and `high` — a different model
   — from one run to the next; and the per-turn design is deliberate (a
   stored tier can only escalate). Done (2026-10-28): very short
   attachment-free turns (`ROUTER_SKIP_CHARS`, 60 characters) are not
   routed and run at `low` — the same place the router's own timeout
   already put them. The signal given up with the call is the page in
   view (`pageSummary`): a short "any red flags?" on a company view used
   to be able to route `medium`; it now runs at `low` unless an insight is
   open (the floor) or the tier is picked by hand. What remains is the
   other product option, persisting
   the tier per thread and re-routing only on attachments, which trades the
   router on every turn for a thread stuck on its heaviest tier; and
   tuning `ROUTER_SKIP_CHARS` once Langfuse shows the routed tier by turn
   length. Since 2026-10-28 every turn's trace carries
   `metadata.effort_routing` — the decision (`requested` / `skipped` /
   `routed` / `unanswered`), the router's answer, the tier run, the turn's
   length, the floor — so the question "what did turns of N characters
   route to" is a Langfuse filter, including for the turns that are now
   skipped and have no `chat.effort_router` trace. Bounding the wait to the
   setup time plus a grace, as first suggested, would with these numbers
   drop most routed answers, so it is withdrawn.
2. **Every checkpoint write carries the whole thread.** One write per model
   call and per tool call, each serialising the full message list — up to
   ~48k tokens of history on a long thread now that the background summary
   keeps it under the in-line trigger. Only a different checkpointer layout,
   or Anthropic's server-side compaction (`compact_20260112`, which the
   installed library already knows) in place of the client-side summariser
   at a lower mark, would change that. Since 2026-10-28 the writes are
   measured: every turn's trace carries `metadata.checkpoint_writes` and the
   score `checkpoint_write_ms` (`checkpointStats.ts` wraps the shared
   saver's `put` / `putWrites` per thread for the turn; `recordTurnWrites`
   files the totals once the run has ended). Chart `checkpoint_write_ms`
   against `messagesAtStart`: a turn on a long thread whose writes add up
   to a noticeable share of its duration is the trigger; a few hundred ms
   across a dozen writes is not worth a checkpointer change.
3. **The checkpoint is read twice per turn.** The route's snapshot
   (`readThreadSnapshot`, for the repairs and the zero-work check) and
   LangGraph's own load inside `streamEvents`. Unavoidable with the
   checkpointer as used; only matters on long threads, and the first read
   now overlaps the router rather than following it.

**Trigger to revisit:** a production timeline showing the router as the
longest pre-stream stage on most turns (it will be), or the summariser
visible as a spike on long threads.

---

## The Copilot is one monolithic agent instead of an orchestrator with subagents

**Area:** `src/lib/agents/analysis/runtime.ts` (the single `createAgent` call),
`src/lib/agents/analysis/flavors/*`, `src/lib/agents/analysis/tools/*`.

**What it is:** every Copilot flavor runs one agent that holds the whole tool
set and the whole system prompt for the whole conversation. A turn that only
looks up a company still carries the insight-editing, email, fund and workforce
tools and their guidance. Every intermediate tool result from a multi-step task
(search hits, schema dumps, company details, CRM rows) also stays in that one
context for the rest of the turn and for every later turn, so long research
tasks get slower, cost more, and crowd out the user's own messages.

**Why we took it:** one agent was the simplest thing that worked. Tools and
flavors were added to it one at a time, and none of those additions was big
enough on its own to justify an orchestration layer.

**Relation to the entry above:** that entry shrinks the *fixed* context of the
one agent (guides behind skills, tool search, deferred tools). This entry is
about splitting the *work*, which also bounds the per-task context the fixed-
context fixes cannot touch. Do the cheap fixes above first. They are not
alternatives.

**Trigger to revisit:** any of:
- a common task (company research, insight drafting) regularly runs more than
  ~10 tool calls in one turn, or hits context limits
- the next flavor or the next large tool group is added
- per-turn latency or token cost on the Copilot becomes a complaint

**Intended fix:**
1. Keep a thin orchestrator agent that holds the conversation, routing guidance
   and a small set of always-needed tools (company lookup, task progress).
2. Split the domain work into subagents, each its own folder under
   `src/lib/agents/<name>/` per the agent design pattern, with only its own tools
   and prompt. Candidate boundaries follow the existing tool groups: research and
   market context, pipeline operations (add/drop/update companies), insights and
   company cards, fund and portfolio analysis, email and outbound.
3. Expose each subagent to the orchestrator as a tool that takes a task brief
   and returns a **condensed result**, not its raw tool transcript. The bounded
   handoff is where the saving comes from.
4. Keep streaming end to end: surface subagent progress through the existing
   stream so the user still sees work happening.
5. Long-running subagent work goes through the jobs / AI Workforce queue
   (which already has a `waiting_for_subagent` status) rather than blocking the
   request.
6. Measure before and after on a fixed set of real conversations: tokens per
   turn, tool calls per turn, latency, and answer quality. Subagents add a model
   call per handoff, so a split that does not cut total tokens is not worth it.

---

## File naming in agent `tools/` encodes kind by case instead of by folder

**Area:** `src/lib/agents/*/tools/` (worst in `analysis`, ~75 files), the
code-map generator's `collectAgents()` (`scripts/build-code-map.ts`), and the
Agent Design Pattern section of `.claude/CLAUDE.md`.

**What it is:**
Inside a `tools/` folder, what a file *is* is encoded in its casing:
snake_case files (`query_companies.ts`, `get_company_details.ts`) are
registered tools, one per file, named after the tool they register; camelCase
files (`attachedHtml.ts`, `companyFilters.ts`, `emailArtifacts.ts`,
`fuzzySearch.ts`, `stageLabels.ts`, `voteSummaries.ts`) are shared helpers
that are not tools at all. Two problems:

1. The repo now has two file-naming conventions, split by an implicit,
   undocumented rule that every new file silently reinforces (each of the six
   helpers was added by following the nearest precedent).
2. The distinction is invisible to tooling. `collectAgents()` globs
   `tools/*.ts` and counts every non-test file as a tool, so the code map
   reports the analysis agent as having "75 tools" when six of those are
   helpers.

**Why we took it:**
Helpers accreted next to their consumers one at a time; co-location was right,
and the case split was the path of least resistance for distinguishing them
without a folder move. Nobody decided it — it emerged.

**Trigger to revisit:**
The next time any `tools/` folder gains a shared helper, or the next time the
code-map tool count is needed as an accurate number — whichever comes first.

**Intended fix:**
One naming convention for all files; express *kind* through the folder path,
never through casing. Concretely: move shared helpers out of `tools/` into a
dedicated folder (e.g. `src/lib/agents/<agent>/lib/`), so "a tool" is defined
as "a file directly under `tools/`" and the helper/tool split is structural.
Then update `collectAgents()` in `scripts/build-code-map.ts` (the glob stays
`tools/*.ts` but now counts only tools), regenerate the map, and update the
Agent Design Pattern folder diagram in `.claude/CLAUDE.md` to show the helper
folder. Tool files stay snake_case only if that remains the single
folder-wide convention (they mirror their registered tool names); otherwise
rename them too — the point is one rule, stated in `CLAUDE.md`, not two
implicit ones.

## Bots: deprecated `bots.system_prompt` and the history import

**Area:** Copilot bots (`docs/features/copilot-bots.md`), `src/lib/services/chatHistoryService.ts`.

**What it is:** two leftovers from moving bot history and personas into their
own homes.

1. **`bots.system_prompt` is still a column.** Superseded by `persona_md`; the
   API still accepts it as an alias, and the persona falls back to it for a row
   whose `persona_md` is empty.
2. **Pre-table threads are imported lazily.** A thread with no
   `copilot_messages` rows is copied from its checkpoint on first read or
   write (`history_imported_at`). A page load racing that thread's first new
   turn can store that turn twice.

**Why we took it:** dropping a column needs a two-phase migration, and a
one-off backfill of every checkpoint thread is a job of its own.

**Trigger to revisit:** one release after `persona_md` shipped, or the first
report of a duplicated message.

**Intended fix:** drop `bots.system_prompt` and the alias; run one backfill
job that imports every remaining thread, then remove the lazy import.

## Routes and a service that bypass the repository/service layers

**Area:** `src/app/api/workforce-queue/route.ts`, `reorder/route.ts`,
`[id]/cancel/route.ts`, `[id]/retry/route.ts`, `[id]/trace/route.ts`.

**What it is:** these handlers build repositories themselves
(`new AiWorkforceQueueRepository(db, …)`, `new UserRepository(db)`,
`new CompanyRepository(db, …)`, …) and call them, skipping the service layer
that `ARCHITECTURE.md` and `.claude/rules/api-routes.md` require. They run no
raw SQL — the queries are still in repositories — but the orchestration that
should be a service method lives in the route.

**Why we took it:** written before the rule was stated explicitly; no route
runs SQL directly today, which was the more urgent half of the rule.

**Trigger to revisit:** the next change to any of these routes.

**Intended fix:** move each handler's repository calls into an
`AiWorkforceService` method and have the route call that service from the
container.

The same rule bars queries in services. One service still runs them:
`src/lib/services/fileService.ts` (~line 2164) checks that a matched
investor / funding source / fund / asset id exists with five inline
`this.db.select(...)` calls. Fix: a `findExistingIds`-style method on each
fund-ledger repository, called from the service.

## Smaller items

**36 endpoints are `fetch`ed inline from views/components**, bypassing the
documented `src/lib/api/*` wrapper layer (`/api/crm`, `/api/graph/*`,
`/api/companies/drop-bulk`, …). There is no single place to discover the client
API surface. Fix opportunistically: add a wrapper when you next touch the call
site.

**Client-safe pure utilities live in `src/lib/services/`** — `flDecimal.ts`,
`flCurrency.ts`, `fundAiOpinionDataSufficiency.ts` are imported by 7 `'use
client'` components. They contradict the "services are classes receiving
repositories" rule and make `@/lib/services/*` non-uniformly server-only. Move
to `src/lib/fundLedger/` (or a `src/lib/money/`).

**`.husky/pre-commit` runs the entire 521-file suite on every commit** — the
slowest possible placement given the import-closure problem above. Consider
scoping it to changed files and leaving the full suite to CI.

**`vitest.config.ts` includes `src/**/*.test.ts`, which excludes `.test.tsx`.**
Zero such files exist today, so nothing is being skipped — but the first
component test anyone writes as `.tsx` will pass by never running. Widen the
glob to `src/**/*.test.{ts,tsx}` pre-emptively.

**`README.md` growth — resolved.** It had reached 182KB / ~45k tokens across 37
sections. The cause was a write-path, not drift: `.claude/CLAUDE.md` told every
agent to "update the README when an architecture change happens" and the
`pr-review` skill enforced it, taking the file from 1.4KB to 182KB in six
months (125x). The content was accurate — 97% of its file references still
resolved — so it was moved, not deleted: 30 feature sections now live in
`docs/features/`, the README is a 126-line landing page, and the three
instructions that fed it were redirected by kind of change (shape ->
`ARCHITECTURE.md`, countable -> `pnpm arch:map`, feature detail ->
`docs/features/`). Four dead file references were corrected in the move.
Watch for the loop returning: any new instruction to document architecture in
`README.md` recreates it.

---

## Company Contact Details card reads every CRM contact of the firm

**Area:** `CompanyContactDiscoveryService.getState`
(`src/lib/services/companyContactDiscoveryService.ts`), polled by
`CompanyContactsSection` every 4s while a contact search runs.

**What it is:** the card loads all of the linked firm's visible
correspondents (`findByEmployerId`), ranks them in memory by
`partnershipRoleRank(title)` and keeps the top five.

**Why we took it:** a pipeline company's CRM firm holds a handful of people,
and the ranking is regex-based — moving it into SQL means a second copy of the
tiers as a `CASE` expression that can drift from the TypeScript one.

**Trigger to revisit:** any linked firm with more than ~200 visible contacts,
or the GET showing up in slow-query logs.

**Fix:** rank in SQL with `LIMIT 5` plus a separate `COUNT(*)`, generating the
`CASE` from `PARTNERSHIP_TITLE_TIERS` so there is one source of truth.

---

## Live updates are one Redis-driven stream — resolved; what the stream still does not cover

**Area:** `src/lib/server/liveEvents.ts`, `src/lib/live/topics.ts`,
`src/lib/live/liveBus.ts`, `GET /api/events`,
`src/components/live/LiveEventsProvider.tsx`.

**What it was:** four server-polling SSE streams (each a function invocation
re-running a full snapshot query every 3 s per open tab), the nav badges on
HTTP polling, and a dozen views each with its own `setInterval` against a
status column (2.5–15 s while something ran).

**Now:** one push stream per tab; every writer publishes `{ topic, ids }`
after its write; no view polls. `.claude/rules/live-updates.md` is the rule,
`docs/features/live-updates-sse.md` the contract and the list of topics and
views.

**Left on the table:**

- **The react-query views do not filter on `ids`.** `LiveEventsProvider`
  invalidates `[topic]` for every frame, so a screening write on one company
  refetches every tab's screening queries (one small GET per tab per event).
  The views that own their state do filter. Add an id-aware
  `useLiveQuery` if a topic gets chatty.
- **Smart Files re-reads every visited bucket** on a `files` frame: the frame
  carries file ids, not the bucket, and a new file is not on any page yet.
  Up to one page GET per visited tab per file event.
- **The workforce trace frames are coalesced to one per second** per run
  (`LiveTraceCallbackHandler`); a run making many tool calls publishes often.
  Fine for a workspace's handful of concurrent runs.
- **A tab that misses a frame** waits for the 60 s safety-net refetch or a
  reconnect's `resync`. A Redis Stream with `Last-Event-ID` would close that
  gap if it ever shows.
- **Two handshakes still wait on a short loop, by design:** the chat Stop
  button asks the server turn every 500 ms (15 s cap) whether it has released
  the thread, and the agent's own lock/presence waits are server-side Redis
  polls. Neither is a view watching state.

**Trigger to revisit:** `GET /api/events` needing per-topic subscriptions, or
a topic's invalidations showing up as repeated identical GETs in function
counts.

---

## CRM profile backfill queues one run at a time

**Area:** `CrmContactEnrichmentService.backfillProfiles`,
`POST /api/auth/crm-contacts/backfill-profiles`.

**What it is:** the backfill loops over its candidates and calls `enrich()` for
each one. Each call does a latest-run lookup, a contact read, a firm read and an
enqueue, so a call costs about four queries per contact. The cap is kept at
50 per call (`BACKFILL_MAX_PER_CALL`) to bound that, and the hourly sweep does
the same at 5.

**Why we took it:** `enrich()` builds the prompt and handles the idempotency
race, and reusing it keeps one enqueue path. The backfill is a one-off admin
call, not a request path.

**Trigger to revisit:** when one backfill call needs to queue more than ~50
runs, or the route nears its `maxDuration`.

**Intended fix:** add a batched enqueue. The candidate query already excludes
contacts with any run, so skip the per-contact latest-run lookup. Read the
contacts and firms with `findByIds`, then insert the queue rows in one
statement.

---

## Fund-of-funds constituents are not modelled (`fl_assets_constituents`)

**Area:** fund ledger (`fl_*` in `src/lib/db/schema.ts`), the Midas data mart
(`midas` schema, `docs/features/midas-data-mart.md`).

**What it is:** a fund-of-funds holding, whether an external `fl_funds` row
(`managed = false`) or an `fl_assets` row tagged
`instrument_terms.investmentTypeLabel = 'Fund of Funds'`, is recorded only as
one line: our commitment, flows and NAV in that fund. Nothing records what the
underlying fund owns, i.e. its investee companies, the amount and ownership
in each, and their cost, value, MOIC and IRR. Star Capital's Midas wants to
show Alpha GWC Fund One's investee list, and that data is still in GP quarterly
reports (Excel/PDF).

**Why we took it:** the ledger was built for our own positions. Look-through
holdings are the GP's numbers as of the GP's report date, not ledger facts, and
the Alpha GWC data isn't ready yet. The mart shipped without it to meet the
Midas integration date.

**Trigger to revisit:** the Alpha GWC investee data is ready to enter, or any
user asks for look-through exposure (by sector, country, company) across fund
interests.

**Fix:** add `fl_assets_constituents`. It holds one row per constituent per
report date, with exactly one parent: `parent_asset_id` → `fl_assets` or
`parent_fund_id` → `fl_funds` (CHECK).

Columns:
- an optional `constituent_asset_id` → `fl_assets`, set when we also hold the
  company directly;
- the name, country, sector and currency;
- `as_of_date`;
- the money fields: `commitment_amount`, `invested_capital`,
  `realized_value`, `unrealized_value`, `ownership_pct`, `moic`, `irr`;
- `data_status`, `source_record_id` → `fl_source_records`, and the usual audit
  columns.

Unique on (`parent_*`, `constituent_name`/`constituent_asset_id`,
`as_of_date`). Feed it from the fund-update import. Add a
`midas.fl_assets_constituents` view to the mart and grant it to `midas_reader`. The
proposed ERD is in the Midas data mart Word document.

---

## Midas data mart hardcodes its workspace IDs

**Area:** `drizzle/migrations/20261026000003_midas_data_mart.sql`.

**What it is:** each `midas.*` view filters on the same three
workspace UUIDs (production, staging, dev) written into the view SQL. Adding a workspace, or a second
external consumer with a different scope, means a new migration that
recreates every view.

**Why we took it:** one consumer, one workspace per environment, and a fixed date. A literal
filter is the simplest thing that is obviously correct.

**Trigger to revisit:** the in-scope workspace list changes, or a second
data-mart consumer appears.

**Fix:** a `midas.workspace_scope (workspace_id)` table (or a per-consumer
scope table) joined by every view, managed from the admin portal.
