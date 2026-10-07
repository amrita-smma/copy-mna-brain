## Start Here

**Read [`ARCHITECTURE.md`](../ARCHITECTURE.md) before working in an unfamiliar
part of this repo.** It is the orientation document: directory map, the
request path, a "where does my change go?" table, and the hazards that have
caused production bugs. It is deliberately short enough to read in full.

To locate a specific route, service, repository, agent tool, job handler or
feature flag, grep [`docs/architecture/code-map.md`](../docs/architecture/code-map.md)
instead of grepping the tree — it is a generated inventory of all of them with
test coverage. Regenerate it with `pnpm arch:map` whenever you add or rename one
of those; CI fails if it is stale. Rules for keeping both current:
`.claude/rules/architecture-docs.md`.

For how one specific feature works, see [`docs/features/`](../docs/features/README.md).
`README.md` is a short landing page — what the project is and how to run it —
not a place to read or write architecture.

## Pull Request Naming

Use a concise, descriptive PR title that summarizes the change. A Jira ticket prefix (e.g. `[MB-123]`) is optional — include one when a ticket exists, but it is not required.

## Admin Routes (`/api/auth`)

Privileged machine-to-machine **admin** endpoints live under `src/app/api/auth/*` and are gated by a shared secret, NOT by a NextAuth session or a chat API key. The `proxy.ts` middleware compares the request's `X-Api-Secret` header against the `ADMIN_SECRET` env var for every path listed in its `matcher`.

Rules when adding or moving an admin route:

- Place the route under `src/app/api/auth/<route>/route.ts`.
- Add its path (and a `:path*` entry for any dynamic segments) to the `matcher` array in `src/proxy.ts` so the `X-Api-Secret` gate applies.
- Do NOT add a per-handler session check (`auth()`); authentication happens in the middleware. The handler should go straight to `createDb()` / `createContainer(db)`.
- Callers must send `X-Api-Secret: <ADMIN_SECRET>`. Server-side internal calls via `src/lib/api/client.ts` (`apiRequest`) attach this header automatically.
- Existing admin routes: `/api/auth/signup`, `/api/auth/api-keys`, `/api/auth/api-keys/:id`.

## Test Files (`**/*.test.ts`)

Test files live next to their source files as `<name>.test.ts`. Rules when writing or editing tests:

- Use **vitest** exclusively — import `describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach` from `'vitest'`. Never use Jest APIs.
- Use `vi.hoisted(() => ({ ... }))` for mock functions that must exist before module-level `vi.mock(...)` calls run.
- Use `vi.mock('@/lib/...')` to stub module dependencies. Prefer class-based mocks for repositories (instantiate a class that exposes the hoisted mock functions as methods).
- Reset mocks in `beforeEach` with `.mockReset()` (or `.mockClear()` when only call counts matter). Add `afterEach(() => vi.clearAllMocks())` when not using `beforeEach`.
- Describe blocks: `describe('ClassName.methodName', ...)` or `describe('functionName', ...)`. Test names state the expected behaviour, not the implementation (e.g., `'returns [] without hitting the DB when the id list is empty'`).
- For **repository tests**: construct the class with a typed `db as never` mock that stubs `.select/.insert/.update/.delete` chains via `vi.fn().mockReturnThis()`.
- For **agent tool tests**: mock `@/lib/server/db` and any repository modules before importing the tool, then test via `tool.invoke({ ... })`. Assert on the string/object returned.
- Keep tests fast and free of real I/O — no network calls, no real database connections.

## Terraform Modules

App-infrastructure modules live under `terraform/` (e.g. `bootstrap`, `iam`, `rds`, `s3`, `ses`, `vpc`). The data-pipeline compute module lives at `data-pipeline/terraform/pipeline-compute/` (co-located with the package it serves).

Each module must have a `Makefile` with `init-staging` and `init-production` targets. Copy the pattern from any existing module's `Makefile` when adding a new one.

## Package Manager

This project uses **pnpm** instead of npm. All Claude Code commands should use pnpm:
- `pnpm install` (not `npm install`)
- `pnpm add <package>` (not `npm install <package>`)
- `pnpm run <script>` (not `npm run <script>`)
- `pnpm test` (not `npm test`)

**Exception:** For the dev server, use `vercel dev` instead of `pnpm run dev` (we use Vercel's built-in tooling).

## Overview

Use Typescript Strict mode.
When processing asynchronous tasks, put them in the jobs table and store state changes in job_logs.
Unit tests should be added for every change to the backend side of the project, which is in src/lib

**Documentation goes to one of four places, by kind of change — never to `README.md`.**
`README.md` grew from 1.4KB to 182KB in six months because every architectural
change was appended to it; it is now a short landing page and must stay that way.

| Kind of change | Write it to |
|---|---|
| System *shape* — a new layer, a change to the request path, a new cross-cutting hazard | `ARCHITECTURE.md` (budgeted ~400 lines) |
| A new route, service, repository, agent tool, job handler, flag or page | nothing by hand — run `pnpm arch:map` |
| How a *feature* works | `docs/features/<feature>.md` + a line in `docs/features/README.md` |
| An accepted shortcut and its payback trigger | `TECH_DEBT.md` |
| An enforceable convention with a review checklist | a new `.claude/rules/*.md`, linked from `ARCHITECTURE.md` |

Only edit `README.md` when setup, the everyday commands, or the top-level
project description change. Full contract: `.claude/rules/architecture-docs.md`.

## Backend Development & Query Performance

The backend layers as: **repositories** (`src/lib/repositories/*`, workspace-scoped Drizzle data access) → **services** (`src/lib/services/*`, compose repositories via `createContainer(db, workspaceId)`) → **App Router routes** (`src/app/api/**/route.ts`, call `createDb()` + `createContainer(...)` then a service). Client views reach the backend through `src/lib/api/*`. Keep SQL/Drizzle in repositories, business logic in services, and only wiring in routes.

**ALWAYS check for and eliminate N+1 query patterns and related database/performance anti-patterns before finishing any backend change.** This is not optional — an N+1 that ships can exhaust the Postgres connection pool (error `53300` "too many connections") under even light concurrency, as the old Fund Management view did.

- **Detect N+1s.** Never call a per-id repository method (e.g. `findByFundAssetId`, `findByFundId`) inside a `.map`/`for`/`forEach` loop or `Promise.all` over a collection. That is a fan-out: server-side it fires one query per row, client-side it fires one HTTP request per row. Both are N+1s. Fetch in bulk instead.
- **Prefer batched queries.** For every single-id lookup that gets called per-collection, add/use a `findByXIds(ids: string[])` counterpart using Drizzle `inArray` (see `findByFundAssetIds` / `findByFundIds` alongside `findByFundAssetId` / `findByFundId` in `fundAssetTransactionRepository.ts`, `fundAssetValuationRepository.ts`, `fundAssetRepository.ts`). Such methods MUST: guard the empty-array case (`if (ids.length === 0) return [];` — never send an empty `inArray`), and `orderBy` the grouping key first so callers can group in a single pass. Then group in memory with a `Map` keyed by the foreign key (see `groupByAssetId` in `fundPortfolioService.ts`).
- **Avoid client-side request fan-out.** Do not issue one HTTP request per row from a React view. Add a single batched/aggregated endpoint instead. The canonical example is `GET /api/funds/portfolio` backed by `FundPortfolioService`, which assembles every fund with its assets and each asset's full transaction + valuation ledger in a fixed handful of batched queries regardless of row count. The anti-pattern it replaced was the view calling `listTransactions`/`listValuations` per asset — that per-asset fan-out opened a DB connection per asset and exhausted the pool (`53300`).
- **Watch for related anti-patterns.** Paginate unbounded result sets rather than selecting everything. Ensure filtered/joined columns have indexes. Use set-based updates instead of `SELECT`-then-loop-and-update-each-row. Hoist or batch repeated identical queries so the same read isn't issued many times per request.

## Detail Dialog Open State

**Never track a record-scoped dialog's `open` as a boolean separate from the selected record.** Derive it: `{selected && <Dialog key={selected.id} open={!!selected} onOpenChange={(o) => { if (!o) setSelected(null); }} />}`. A separate boolean leaves the dialog mounted after close, holding the previous record's fetched state, so the next open flashes the previously-viewed record — the "opening a company card blips to the older card" bug. Any open handler that fetches before setting state also needs an `activeRequestIdRef` guard so a slow earlier response can't beat a newer click. Full rule, rationale and review checklist: `.claude/rules/dialog-open-state.md`.

## Card & Surface Backgrounds

**Never ship a card or panel with a transparent (or partially transparent) background.** Anything that reads as a raised surface — a bordered/rounded container, a panel, a popover, an empty-state box, a summary tile — must paint an opaque background so whatever sits behind it (page background, another card, a sticky header scrolling underneath) cannot show through.

- Use `bg-card` for a surface sitting on the page background, and `bg-muted` for a subtler surface or one nested inside another card. Both are opaque.
- Do **not** use alpha-suffixed utilities for a surface background: `bg-muted/20`, `bg-muted/30`, `bg-background/80`, `bg-card/50` and friends are banned on cards. Alpha is fine only for genuine overlays (dialog scrims, hover/active tints on a control, gradient fades).
- A `rounded-* border` container with no `bg-*` class at all is also transparent — give it one.
- Check both themes: a tint that looks solid in light mode is usually see-through in dark mode.

## Country Codes

Country values (`companies.geography`) are stored as free-text country **names**, not codes. When rendering a flag, do not hardcode a flag emoji per country — resolve the name to its **ISO 3166-1 alpha-2** code with the `country-to-iso` library (`countryToAlpha2("South Korea")` → `"KR"`; it tolerates inconsistent inputs like `USA`/`United States`), then derive the emoji from that code via Unicode regional indicator symbols (`0x1F1E6 + (charCode - 'A')`). Values that aren't countries (e.g. `"Asia Pacific"`) return `null` → fall back to a globe. Avoid hand-maintained name→code maps; only add a tiny alias for genuinely ambiguous names the library can't resolve (e.g. bare `"Korea"` → `"South Korea"`).

## Database Seeding

The primary local dev seeder is `scripts/seed.ts` (run via `pnpm db:seed`). It seeds companies, the CRM (employers, correspondents, topics with deal/non-deal classification, team coverage, notes), and the AUTO VEHICLE ingest fixture. Do **not** add new standalone seed scripts for individual features — extend `seed.ts` (its `seedCompanies` / `CRM_ENRICHMENT` / `SEED_TOPICS` / related fixtures) instead, so feature seed data stays consolidated under a single command. A couple of separate seeders exist for distinct purposes (`db:seed:neo4j` and the bad-EBITDA HITL fixture); don't add to that list — fold new data into `seed.ts`.

## Database Migrations

Generate every new Drizzle migration with `pnpm db:migration:new <name>` (add `data-pipeline/migrations` as a second arg for pipeline migrations) — never hand-craft the filename or edit `meta/_journal.json` yourself. Filenames are `YYYYMMDDXXXXXX_<slug>.sql`, where `XXXXXX` is a per-day zero-padded counter (not a timestamp): the first migration on a UTC date is `000000`, the next is `000001`, and so on. The journal is fully derived from filenames by `scripts/build-drizzle-journal.ts` (`pnpm db:journal`), which the generator runs for you automatically. Full detail: `.claude/rules/drizzle-migrations.md`.

## Agent Design Pattern (`src/lib/agents`)

Each agent lives in its own folder under `src/lib/agents`, named after the agent. The folder structure must be:

```
src/lib/agents/<agent_name>/
  index.ts                      # Main agent entrypoint — must use `createAgent` and stream
  tools/
    index.ts                    # Registers all tools for the agent
    <tool_name>.ts              # One file per tool (one tool per file)
    <tool_name>.test.ts         # Unit tests for the tool
```

Rules:
- Each agent's `index.ts` is the main entrypoint and must use `createAgent`.
- Each agent must be streaming.
- Each tool gets its own dedicated file under `tools/`.
- `tools/index.ts` is responsible for registering all tools.
- Every tool must have unit tests.

## Feature Flags

Feature flags live in `src/lib/flags.ts` (e.g. `companyGraphEnabled`).

**Server components (Next.js pages)** — fetch flags with `await` and pass as boolean props:

```ts
// src/app/some-page/page.tsx
import { companyGraphEnabled } from '@/lib/flags';

export default async function SomePage() {
  const showCompanyGraph = await companyGraphEnabled().then(Boolean);
  return <SomeView showCompanyGraph={showCompanyGraph} />;
}
```

**Views** — accept flags as boolean props, pass them to `DashboardLayout`:

```ts
interface SomeViewProps {
  showCompanyGraph?: boolean;
}

export default function SomeView({ showCompanyGraph = false }: SomeViewProps) {
  return (
    <DashboardLayout showCompanyGraph={showCompanyGraph}>
      ...
    </DashboardLayout>
  );
}
```

**`DashboardLayout`** — filters `baseNavigation` based on the boolean props. All flag resolution happens server-side in the page file; do not resolve flags inside `DashboardLayout` or any view. When a view has multiple render branches (loading, error, empty states), every `<DashboardLayout>` it renders must receive the same flag props, or the nav item will flicker in and out across states.

When adding a new feature-flagged nav item:
1. Add the flag function to `src/lib/flags.ts`
2. Add a `show<FeatureName>` prop to `DashboardLayoutProps` (default `false`)
3. Add the filter in `DashboardLayout`'s `filteredNavigation`
4. Thread the prop through every page file and view
