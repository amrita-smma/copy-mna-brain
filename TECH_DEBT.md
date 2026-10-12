# Tech Debt

A running log of known, accepted shortcuts and the conditions under which they
should be paid down. Each entry: what the shortcut is, why we took it, the
trigger to revisit, and the intended fix.

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

## Runtime import cycle spanning 72 modules

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

**Trigger to revisit:** when vitest or the TS language server becomes
noticeably slow, or at the next change to agent tool registration.

**Intended fix, in order:**
1. Have the 18 agent tools resolve the container lazily inside `invoke()`
   (`await import('@/lib/services/container')`) rather than at module scope.
2. Stop re-exporting `./container` from `src/lib/services/index.ts`; make routes
   import `createContainer` from `@/lib/services/container` explicitly.
3. Prefer direct module imports over the `@/lib/services` barrel in new code.

---

## `createContainer` eagerly constructs every service on every request

**Area:** `src/lib/services/container.ts`.

**What it is:**
`createContainer` is a single 454-line function (in a 659-line file) that news
up ~74 repositories and all 62 `Container` service keys on every call, for all
190 routes, regardless of which one the handler uses. It is also the reason the
barrel's import closure is 414 modules (above).

**Why we took it:** a flat eager factory is simple to read and trivially
type-safe; at current traffic the per-request allocation is not the bottleneck.

**Trigger to revisit:** when per-request CPU shows up in profiling, or once the
import-cycle work above lands (the two are coupled).

**Intended fix:** convert the returned object to lazy getters so a service is
constructed on first property access. The `Container` interface is unchanged,
so no call site moves.

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
  `*.log` is already in `.gitignore`), `inven-swagger.json` (8 months),
  `.vercel/project.json`.
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
