# Tech Debt

A running log of known, accepted shortcuts and the conditions under which they
should be paid down. Each entry: what the shortcut is, why we took it, the
trigger to revisit, and the intended fix.

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

**What is already correct and should not be "fixed":** prompt caching. The model
binds `cache_control` via `withConfig` (`runtime.ts:166-174`, with an accurate
comment on why the constructor form is ignored by `@langchain/anthropic`), chat
deliberately skips context-editing to protect the cached prefix, and
`lazyToolList.ts` documents the real cycle it works around. The fixed prefix is
therefore cached at ~0.1x after the first turn — the remaining cost is the
turn-one cache write plus 0.1x on every tool-loop iteration.

**Trigger to revisit:** when adding the next flavor or the next ~5 tools.

**Intended fix (highest value first):**
1. Move `MNA_PIPELINE_OPERATIONS_GUIDE` behind progressive disclosure (an Agent
   Skill) so the body loads only when the task calls for it.
2. Delete the numbered tool enumeration from the flavor system prompts; move any
   when-to-use guidance into each tool's own `description`, where it also lifts
   call rate.
3. Adopt Anthropic's tool-search server tool
   (`tool_search_tool_regex_20251119`) with `defer_loading: true` on long-tail
   tools. Discovered schemas are *appended*, not swapped, so unlike the existing
   `withoutTools()` path (`runtime.ts:63`, which eats a cache miss by design)
   this preserves the prompt cache. Constraints: the search tool itself must not
   be deferred, and at least one tool must stay non-deferred.
4. Defer `add_company` and `send_email` first.

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

## Live updates are four separate server-polling SSE streams, plus client pollers

**Area:** `src/lib/server/sse.ts` (`changeStream`), `src/hooks/useEventStream.ts`,
the routes `/api/screenings/stream`, `/api/companies/stream` and
`/api/ai-screening/tasks/stream`, and the react-query pollers
`useWorkforceNavSummary` (5s) and `useSourcingPendingCount` (60s).

**What it is:** each live view opens its own `EventSource`, and each stream is
its own function invocation re-running a full snapshot query every 3s for up to
240s, only to tell the client nothing changed. The Pipeline page holds three
streams at once (four with a company dialog open). The sidebar's nav badges,
mounted on every page, are still plain HTTP polling. So SSE here saves
requests, not database work: every open tab costs one query per stream per
tick whether or not anything moved.

**Why we took it:** `changeStream` dropped onto an existing service method with
no new infrastructure, and each stream was added for one view at a time.

**Trigger to revisit:** a fifth live surface (the nav badges are the obvious
next one), stream routes showing up in function-duration or slow-query
dashboards, or tabs hitting the per-origin connection limit on HTTP/1.1.

**Fix:** one workspace-scoped stream driven by Redis, not by polling. The
pieces now exist for the Copilot bots and are the pattern to extend: the
client in `src/lib/server/redis.ts` (`getRedis`, `createRedisSubscriber`),
the channels `ws:<workspaceId>` / `ws:<workspaceId>:user:<userId>` in
`src/lib/bots/presence.ts`, the publish-on-write calls in `BotService`, and
the route `GET /api/bots/events` (snapshot on connect, pub/sub after, a
reconcile tick, 240 s lifetime) with `ChatProvider` as its one client. See
`docs/features/copilot-bots.md` § Live presence.

- **Publish on write.** Each service that changes live state (workforce queue
  status transitions and `markFailureSeen`, screening state/result writes, AI
  Opinion status, sourcing confirmations) publishes `{ topic, ids? }` to the
  Redis channel `ws:<workspaceId>:events` after its write commits. Publishing
  is a service concern; repositories stay pure data access. The workforce
  dispatcher's status changes need publishing too, because they run outside
  any request.
- **One route, `GET /api/events`.** It subscribes to the workspace channel and
  forwards each message as `event: invalidate`. There are no query params, so
  one connection serves every page and never reconnects on navigation. Clients
  filter by `ids` themselves. Keep the lifetime cap and heartbeat from
  `changeEvents`. On reconnect, send a `resync` frame so the client refetches
  whatever it missed while disconnected, since pub/sub doesn't replay (or use a
  Redis Stream with `Last-Event-ID` if gaps matter).
- **One client, `<EventStreamProvider>` in `AppShell`.** It maps each topic to
  `queryClient.invalidateQueries({ queryKey: [topic] })`. Live views become
  ordinary `useQuery` hooks with a slow fallback `refetchInterval`. Delete the
  three stream routes, `changeStream`, `useEventStream`, and the per-feature
  polling cadences.
- **Fold in the remaining `setInterval` pollers** where they watch server state
  (`CompanyVotingTab`, `CompanyDetail` / `CompanyDetailDialog` in the same PR
  per the parity rule, `WorkforceTasks`, `DocumentInsightsPanel`,
  `InsightEditApprovalCard`), and update `docs/features/live-updates-sse.md`.
