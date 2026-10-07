# mna-brain

An M&A deal platform: a company pipeline, a CRM, a fund ledger, a document
ingest pipeline, and an AI copilot over all of it. Next.js App Router, Postgres
via Drizzle, Neo4j for the relationship graph, LangGraph agents on Claude, and a
separate AWS Lambda data pipeline for email/document ingest.

## Where to go next

| You want… | Read |
|---|---|
| Orientation — layers, request path, where new code goes | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| To locate a route, service, repository, agent tool, job or flag | [`docs/architecture/code-map.md`](docs/architecture/code-map.md) (generated) |
| How a specific feature works | [`docs/features/`](docs/features/README.md) |
| Known shortcuts and what would trigger paying them down | [`TECH_DEBT.md`](TECH_DEBT.md) |
| The data pipeline (separate workspace) | [`data-pipeline/README.md`](data-pipeline/README.md) |

Working in here as an agent? `.claude/CLAUDE.md` and `.claude/rules/` carry the
enforceable conventions.

## Getting started

This project uses **pnpm**, and **`vercel dev`** rather than `pnpm run dev` —
the dev server needs Vercel's edge config and feature flags.

### 1. Install the Vercel CLI

```bash
npm i -g vercel
```

### 2. Pull environment variables

Local development reads from `.env.vercel` (gitignored). Link the project and
pull the latest values:

```bash
vercel link
vercel env pull .env.vercel
```

Re-run `vercel env pull .env.vercel` whenever environment variables change in
the Vercel dashboard.

### 3. Install dependencies and run

```bash
pnpm install
vercel dev
```

### 4. Set up the database

```bash
pnpm db:migrate   # apply migrations
pnpm db:seed      # seed local dev data
```

## Tests

### Unit tests

Backend code under `src/lib` is covered by [Vitest](https://vitest.dev), in
`.test.ts` files colocated next to the code they cover.

```bash
pnpm test          # run once
pnpm test:watch    # watch mode
```

### End-to-end tests

E2E tests live in `./e2e` and run with [Playwright](https://playwright.dev).
`playwright.config.ts` launches `vercel dev` automatically and reuses an
existing server on `http://localhost:3000`.

Install the browser binaries once per machine:

```bash
pnpm exec playwright install
```

Then:

```bash
pnpm test:e2e                                      # all tests, headless
pnpm test:e2e:ui                                   # watch / time-travel UI
pnpm exec playwright test e2e/dashboard.spec.ts    # one spec
pnpm exec playwright test -g "paginates at 10"     # one test by name
pnpm exec playwright test --headed --debug         # headed / debug
pnpm exec playwright show-report                   # open the HTML report
```

## Other commands

```bash
pnpm lint                  # eslint
pnpm arch:map              # regenerate docs/architecture/code-map.md
pnpm db:migration:new <n>  # create a migration (never hand-name one)
```

`data-pipeline/` is a separate pnpm workspace:
`pnpm --filter data-pipeline <script>`.

## Skipping deployments

Vercel runs `scripts/skip-deploy.sh` as its
[Ignored Build Step](https://vercel.com/docs/projects/overview#ignored-build-step)
for every branch. A build is skipped when the commit message matches:

| Pattern | Example |
|---|---|
| `[skip deploy]` anywhere in the message | `fix typo [skip deploy]` |
| `[skip ci]` anywhere in the message | `update docs [skip ci]` |
| Message begins with `chore:` | `chore: bump deps` |

## Documentation layout

Four containers, so no single file becomes a dumping ground again:

- **`README.md`** (this file) — what the project is and how to run it. Stays short.
- **`ARCHITECTURE.md`** — the shape of the system. Budgeted at ~400 lines.
- **`docs/architecture/code-map.md`** — generated inventory; CI fails if stale.
- **`docs/features/`** — one file per feature, however long it needs to be.

Rules for keeping these true: `.claude/rules/architecture-docs.md`.
