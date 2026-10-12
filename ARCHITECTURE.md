# Architecture

Orientation for anyone — human or agent — landing in this repo cold. Read this
first; it is the only architecture document you need to read in full.

- **This file** explains the *shape*: the layers, the request path, where new
  code goes, and the things that will bite you. Hand-written, changes rarely,
  budgeted at ~400 lines so it stays readable in full.
- **[`docs/architecture/code-map.md`](docs/architecture/code-map.md)** is the
  *inventory*: every route, service, repository, agent, job and flag, with
  counts and test coverage. Generated from the filesystem by `pnpm arch:map`;
  CI fails if it is stale. Grep it instead of grepping the tree.
- **[`docs/features/`](docs/features/README.md)** holds *feature* deep dives,
  one file each — async jobs, the app shell, copilot flavors, and ~27 more.
- **`README.md`** is the landing page: what this is and how to run it. Nothing
  architectural belongs there; it reached 182KB that way once.
- **`.claude/CLAUDE.md` + `.claude/rules/*.md`** are the *enforceable rules*.
  Where this file and a rule disagree, the rule wins.

## What this is

An M&A deal platform: a company pipeline, a CRM, a fund ledger, a document
ingest pipeline, and an AI copilot over all of it. Next.js App Router, Postgres
via Drizzle, Neo4j for the relationship graph, LangGraph agents on Claude, and a
separate AWS Lambda data pipeline for email/document ingest.

## Directory map

```
src/
  app/              Next.js App Router. Pages are thin; they resolve feature
    api/**/route.ts   flags and render a view. ~190 API route handlers.
    w/[workspaceSlug]/   The real app. Everything workspace-scoped lives here.
    <legacy>/         Pre-workspace deeplinks that redirect into /w/<slug>.
  views/            Page-level React components. One per route, plus subfolders
                      for big features (fundManagement/, crm/, ledger/).
  components/       Reusable UI. `ui/` is shadcn; the rest is feature-grouped.
  hooks/            Shared React hooks.
  lib/
    repositories/   Workspace-scoped Drizzle data access. ONLY layer touching the DB.
    services/       Business logic. Composed by container.ts.
    agents/         LangGraph agents, one folder each, one file per tool.
    jobs/           Async job dispatch + handlers.
    api/            Client-side wrappers the views call. Not server code.
    db/schema.ts    The Drizzle schema. Single file, ~4.5k lines.
    flags.ts        Feature flags.
    workspace.ts    Active-workspace resolution. Highest fan-in module in the repo.
data-pipeline/      Separate pnpm workspace. AWS Lambda email/document ingest.
drizzle/migrations/ App migrations.   scripts/   One-off + build scripts.
terraform/          App infrastructure.  e2e/   Playwright specs.
```

## The request path

Backend work flows one direction. Nothing skips a layer.

```
view  →  src/lib/api/*  →  route.ts  →  service  →  repository  →  Postgres
         (fetch wrapper)   (wiring)    (logic)     (Drizzle)
```

A route handler is wiring and nothing else:

```ts
export async function GET(req: NextRequest) {
  try {
    const db = createDb();
    const { companyService } = createContainer(db, await getActiveWorkspaceId());
    return NextResponse.json({ data: await companyService.list(/* … */) });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
```

- `createDb()` and `createContainer()` are called **inside** the handler, never
  at module scope.
- Services receive repositories by constructor injection and never call
  `createDb()` themselves.
- Repositories are workspace-scoped classes. Business rules do not live there.
  The one exception is `UserMemoryRepository`, which is scoped to the *user*:
  CoPilot memory follows a person across workspaces by design, so adding a
  workspace filter there silently breaks recall (`docs/features/copilot-memory.md`).
- Slow I/O goes through `JobDispatcher`, not inline in the request.

Full rules: `.claude/rules/api-routes.md`, `services.md`, `repositories.md`.

## The render path

```
app/w/[slug]/x/page.tsx  →  views/X.tsx  →  components/**  →  lib/api/*  →  /api/x
      (server)                (client)
```

Feature flags resolve **server-side in the page file** and pass down as boolean
props — never resolved inside a view or inside `DashboardLayout`. A view with
several render branches must pass the same flag props to every `DashboardLayout`
it returns, or the nav item flickers between states.

## Where does my change go?

| I want to… | Touch |
|---|---|
| Add a DB table/column | `src/lib/db/schema.ts` + `pnpm db:migration:new <name>` |
| Read/write data a new way | A repository in `src/lib/repositories/` (+ `.test.ts`) |
| Add business logic | A service in `src/lib/services/` + wire into `container.ts` (+ `.test.ts`) |
| Expose it over HTTP | `src/app/api/<route>/route.ts` |
| Call it from the UI | A wrapper in `src/lib/api/`, then the view |
| Add a privileged M2M endpoint | `src/app/api/auth/<route>/` **and** the `matcher` in `src/proxy.ts` |
| Add a copilot tool | `src/lib/agents/<agent>/tools/<tool>.ts` + register in `tools/index.ts` (+ `.test.ts`) |
| Run something slowly/async | `job_type` enum + `src/lib/jobs/handlers/` + dispatch via `JobDispatcher` |
| Gate a feature | `src/lib/flags.ts`, then thread the boolean through page → view → layout |
| Add seed data | Extend `scripts/seed.ts`. Do not add a new seeder. |

Every backend change under `src/lib` needs unit tests. After any backend change,
check for N+1 queries before you finish — see below.

## Things that will bite you

**N+1 queries are the #1 production hazard here.** Never call a per-id
repository method inside a `.map`/`for`/`Promise.all` over a collection —
server-side that is one query per row, client-side one HTTP request per row.
Both have exhausted the Postgres connection pool (`53300`) in this app before.
Add a `findByXIds(ids: string[])` counterpart using `inArray`, guard the empty
array, `orderBy` the grouping key, and group in memory with a `Map`.
`FundPortfolioService` is the reference implementation.

**`createContainer` is eager.** One 454-line function constructs every
repository and all 62 `Container` service keys on every request, for all 190
routes. Importing it — or the `@/lib/services` barrel that re-exports it —
pulls in ~414 modules. Prefer importing a service module directly over the
barrel in new non-route code.

**There is a runtime import cycle** spanning ~72 modules:
`container → services → jobs/handlers → agents/analysis/tools → container`.
It is why `src/lib/agents/analysis/flavors/lazyToolList.ts` exists — a
module-scope `[...tools]` throws `ReferenceError` at Next build time. Read that
file's header before touching agent tool lists.

**Record-scoped dialogs must derive `open` from the selected record.** A
separate `open` boolean leaves the dialog mounted holding the previous record's
state, so the next open flashes the old record. Always
`{selected && <Dialog key={selected.id} open={!!selected} … />}`, and guard any
fetch-before-open with an `activeRequestIdRef`. Full rule:
`.claude/rules/dialog-open-state.md`.

**Cards and panels must paint an opaque background** (`bg-card` / `bg-muted`).
Alpha-suffixed utilities are banned on surfaces — they look solid in light mode
and see-through in dark.

**Every console page opens with the shared `PageHeader` band**
(`src/components/layout/PageHeader.tsx`), not a hand-rolled title row. The band
is full-bleed, so page padding goes on the content below it, and its title is
the page's only `<h1>`. Full rule: `.claude/rules/page-header.md`.

**Migrations use a date + per-day counter, not a timestamp.** Always
`pnpm db:migration:new <name>`; never hand-name a file or edit `_journal.json`.

**`geography` is a free-text country name, not a code.** Resolve to ISO alpha-2
with `country-to-iso` before deriving a flag emoji.

**Langfuse traces are lost unless the queue is drained.** Its callbacks are
fire-and-forget, and a serverless function can be frozen with a turn's events
still queued. `runJob`, `runAgent`, the chat route and the daily pulse each
`await flushLangfuse()` in a `finally`; a new agent entrypoint that bypasses all
four must do the same. Merge the handler with `withLangfuseCallbacks(config)`,
never by spreading `callbacks` by hand — LangChain allows a bare handler there
and the hand-rolled spread throws on it. A WDK `'use workflow'` body may import
only `@/lib/langfuseClient`, never the `@/lib/langfuse` barrel: the barrel
reaches `node:async_hooks` and the workflow bundle refuses to build on it. See
`docs/features/langfuse-tracing.md`.

## Commands

```bash
pnpm install               # pnpm, not npm
vercel dev                 # dev server (not pnpm run dev)
pnpm test                  # vitest (src/**/*.test.ts)
pnpm lint                  # eslint
pnpm arch:map              # regenerate docs/architecture/code-map.md
pnpm arch:map:check        # fail if the map is stale (CI)
pnpm db:migrate            # apply migrations
pnpm db:migration:new <n>  # create one
pnpm db:seed               # seed local dev
pnpm test:e2e              # playwright
```

`data-pipeline/` is a separate workspace: `pnpm --filter data-pipeline <script>`.

## Keeping this document true

`ARCHITECTURE.md` is prose about structure; `code-map.md` is generated facts.
That split is what keeps the pair accurate — the half that rots fastest is the
half nobody has to write.

Update **this** file when you change the *shape* of the system: a new top-level
directory, a new layer, a change to the request path, a new cross-cutting
hazard, or a new rule in `.claude/rules/`. Do not add inventories, counts, or
per-file lists here — those belong in the generated map, and a hand-written
count is wrong within a sprint.

Regenerate the map with `pnpm arch:map` whenever you add a route, service,
repository, agent, job handler, feature flag or page. CI runs
`pnpm arch:map:check` and fails if you forget. See
`.claude/rules/architecture-docs.md` for the full contract.
