# Data Navigator RSS News Lake — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest ~263 curated RSS feeds into a dedicated `rss` Postgres schema, enrich a filtered subset with full article text and Bedrock embeddings, and surface it as a filterable "Data Navigator" page plus a RAG tool for the chat agents.

**Architecture:** Two scheduled Lambdas in the existing `data-pipeline` SAM stack. `rss-poll` (every 30 min) conditional-GETs every active feed, archives raw NDJSON to a new S3 bucket, and upserts item metadata. `rss-enrich` (every 10 min) classifies pending items with Haiku, fetches full article text for the selected subset, and embeds it into pgvector. The Next.js app reads that schema through the standard repository → service → route layering and renders a master–detail news page.

**Tech Stack:** TypeScript strict, Drizzle ORM 0.45 (Postgres 16 + pgvector + pg_trgm), AWS Lambda (nodejs20/22) via SAM + Terraform, `rss-parser`, `@extractus/article-extractor`, `@anthropic-ai/sdk` (Haiku), `@aws-sdk/client-bedrock-runtime` (Titan Embed v2), Next.js App Router, vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-data-navigator-rss-lake-design.md`

## Global Constraints

These apply to every task. Read them once; they are not repeated per task.

- **Package manager is pnpm.** `pnpm add`, `pnpm test`, `pnpm --filter data-pipeline test`. Never npm.
- **TypeScript strict mode.** No `any` in committed code; use `unknown` + narrowing.
- **Layering (app):** repositories (`src/lib/repositories/*`) own all SQL → services (`src/lib/services/*`) own business logic → routes (`src/app/api/**/route.ts`) only wire `createDb()` + `createContainer(db, workspaceId)`. Services never import from `src/app/` or use Next.js APIs.
- **No N+1.** Never call a per-id repository method inside a loop or `Promise.all` over a collection. Every `inArray` call must guard `if (ids.length === 0) return [];`.
- **Route envelope:** success is `NextResponse.json({ data })`, failure is `NextResponse.json({ error: message }, { status })`. Whole handler body wrapped in try/catch returning 500.
- **Tests:** vitest only (`describe`/`it`/`expect`/`vi`/`beforeEach` from `'vitest'`). Repository tests use a chainable `mockDb` cast `as never`. Service tests use plain object mocks cast `as unknown as XRepository`. No real network or DB in tests. Every backend change gets tests.
- **Migrations:** generate with `pnpm db:migration:new <name> data-pipeline/migrations`. Never hand-craft filenames, never edit `meta/_journal.json`. The `rss` schema is pipeline-owned, so its migrations live in `data-pipeline/migrations` (same precedent as `analytics`), and `pnpm db:migrate` applies both folders.
- **Categories** are the five fixed slugs: `expert_insights`, `market_assessment`, `new_funding`, `ma_partnerships`, `industry_reports`.
- **Deliberate deviation from the spec:** the spec says category is a pg enum. Use `text` + a `CHECK` constraint instead — adding a sixth category later becomes a one-line constraint swap rather than an enum migration dance. The TypeScript union type is the real contract.
- **Bedrock region:** Bedrock is **not available in `ap-southeast-3`** (Jakarta), where the pipeline Lambdas run. All Bedrock calls use a separate `BEDROCK_REGION` env var defaulting to `ap-southeast-1`. Never reuse `AWS_REGION` for Bedrock.
- **Feature flag key:** `DATA_NAVIGATOR_ENABLED`, default OFF.
- **Daily selection cap:** `RSS_DAILY_CAP_PER_CATEGORY`, default `25` (125/day ceiling across five categories).
- **Retention:** nothing is pruned. `content_text` is kept indefinitely.
- **Commit after every task.** Conventional commits (`feat:`, `test:`, `chore:`).

## Prerequisites

Run once before Task 1 — this worktree may be freshly checked out:

```bash
pnpm install
pnpm db:migrate     # bring the local DB up to main before adding to it
```

Local Postgres must have **pgvector** available. If `CREATE EXTENSION vector`
fails in Task 1, switch the local container image to `pgvector/pgvector:pg16`
(RDS 16 ships it already, so this is a local-only concern).

## Phase Map

| Phase | Tasks | Deliverable |
|-------|-------|-------------|
| 1. Schema + catalog | 1–5 | `rss` schema live, 263 feeds importable via admin API, seeded locally |
| 2. Poll pipeline | 6–10 | `rss-poll` Lambda writing bronze + item metadata, deployed |
| 3. Enrich pipeline | 11–15 | Classification, content fetch, embeddings |
| 4. App API + page | 16–20 | `/data-navigator` page behind the flag |
| 5. RAG tool + wrap-up | 21–23 | `search_news` agent tool, e2e coverage, docs |

---

# Phase 1 — Schema and feed catalog

### Task 1: `rss` schema migration

**Files:**
- Create: `data-pipeline/migrations/<generated>_rss_schema.sql`
- Modify: `data-pipeline/drizzle.config.ts` (schemaFilter)

**Interfaces:**
- Consumes: nothing.
- Produces: tables `rss.feeds`, `rss.items`, `rss.item_chunks`, `rss.ingest_runs`. Every later task depends on these column names exactly as written here.

- [ ] **Step 1: Generate the migration file**

```bash
pnpm db:migration:new rss_schema data-pipeline/migrations
```

This prints the created path, e.g. `data-pipeline/migrations/20260902000000_rss_schema.sql`, and regenerates the journal. Use whatever path it printed in the next step.

- [ ] **Step 2: Write the migration SQL**

Replace the generated file's contents entirely with:

```sql
-- Data Navigator RSS news lake.
--
-- Pipeline-owned schema (same ownership model as `analytics`): the rss-poll /
-- rss-enrich Lambdas write it, the Next.js app reads it and administers the
-- feed catalog. Deliberately NOT workspace-scoped — the feed catalog and the
-- news items are global across all workspaces.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SCHEMA IF NOT EXISTS rss;

-- ── Feed catalog ────────────────────────────────────────────────────────────
-- etag / last_modified replace the PoC's http_cache.json: they carry HTTP
-- conditional-GET state so an unchanged feed costs one 304 instead of a parse.
CREATE TABLE IF NOT EXISTS rss.feeds (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category             TEXT NOT NULL,
  source_name          TEXT NOT NULL,
  feed_url             TEXT NOT NULL UNIQUE,
  region               TEXT,
  tier                 TEXT NOT NULL DEFAULT 'curated',
  status               TEXT NOT NULL DEFAULT 'active',
  notes                TEXT,
  etag                 TEXT,
  last_modified        TEXT,
  last_polled_at       TIMESTAMPTZ,
  last_success_at      TIMESTAMPTZ,
  consecutive_failures INT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rss_feeds_category_check CHECK (category IN (
    'expert_insights', 'market_assessment', 'new_funding',
    'ma_partnerships', 'industry_reports'
  )),
  CONSTRAINT rss_feeds_tier_check CHECK (tier IN ('curated', 'query')),
  CONSTRAINT rss_feeds_status_check CHECK (status IN ('active', 'paused', 'dead'))
);

-- The poll Lambda's driving query.
CREATE INDEX IF NOT EXISTS idx_rss_feeds_status_category
  ON rss.feeds (status, category);

-- ── Items ───────────────────────────────────────────────────────────────────
-- One row per unique news item. Metadata is stored for EVERY item; only the
-- LLM-selected subset gets content_text + embeddings.
--
-- category/source_name/region/feed_tier are denormalized from rss.feeds on
-- purpose: a feed row can be re-categorized or renamed later, but an item is
-- an immutable historical fact about what was published where.
CREATE TABLE IF NOT EXISTS rss.items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_hash          TEXT NOT NULL UNIQUE,
  feed_id            UUID REFERENCES rss.feeds(id) ON DELETE SET NULL,
  category           TEXT NOT NULL,
  source_name        TEXT NOT NULL,
  region             TEXT,
  feed_tier          TEXT NOT NULL DEFAULT 'curated',
  title              TEXT NOT NULL,
  link               TEXT NOT NULL,
  summary            TEXT,
  authors            TEXT,
  tags               TEXT,
  published_at       TIMESTAMPTZ,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  relevance          TEXT NOT NULL DEFAULT 'pending',
  relevance_score    REAL,
  llm_labels         JSONB,
  classified_at      TIMESTAMPTZ,
  content_status     TEXT NOT NULL DEFAULT 'none',
  content_text       TEXT,
  content_fetched_at TIMESTAMPTZ,
  content_attempts   INT NOT NULL DEFAULT 0,
  content_error      TEXT,
  embedded_at        TIMESTAMPTZ,
  CONSTRAINT rss_items_relevance_check CHECK (relevance IN ('pending', 'selected', 'rejected')),
  CONSTRAINT rss_items_content_status_check CHECK (content_status IN ('none', 'pending', 'fetched', 'failed'))
);

-- Feed list ordering (newest first), with and without a category filter.
CREATE INDEX IF NOT EXISTS idx_rss_items_published_at
  ON rss.items (published_at DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS idx_rss_items_category_published
  ON rss.items (category, published_at DESC NULLS LAST, id DESC);

-- Enrich-stage work queues. Partial indexes keep them tiny regardless of how
-- large rss.items grows.
CREATE INDEX IF NOT EXISTS idx_rss_items_pending_classification
  ON rss.items (ingested_at DESC)
  WHERE relevance = 'pending';
CREATE INDEX IF NOT EXISTS idx_rss_items_pending_content
  ON rss.items (ingested_at DESC)
  WHERE relevance = 'selected' AND content_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_rss_items_pending_embedding
  ON rss.items (content_fetched_at DESC)
  WHERE content_status = 'fetched' AND embedded_at IS NULL;

-- Daily-cap counting: "how many selected in this category today".
CREATE INDEX IF NOT EXISTS idx_rss_items_category_classified
  ON rss.items (category, classified_at DESC)
  WHERE relevance = 'selected';

-- ILIKE half of hybrid search.
CREATE INDEX IF NOT EXISTS idx_rss_items_title_trgm
  ON rss.items USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_rss_items_authors_trgm
  ON rss.items USING gin (authors gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_rss_items_source_name_trgm
  ON rss.items USING gin (source_name gin_trgm_ops);

-- ── RAG chunks ──────────────────────────────────────────────────────────────
-- 1024 dims = amazon.titan-embed-text-v2:0 with dimensions=1024.
CREATE TABLE IF NOT EXISTS rss.item_chunks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     UUID NOT NULL REFERENCES rss.items(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  text        TEXT NOT NULL,
  embedding   vector(1024) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_rss_item_chunks UNIQUE (item_id, chunk_index)
);

-- Cosine HNSW. m/ef_construction are pgvector defaults, stated explicitly so a
-- future tuning change is a visible diff.
CREATE INDEX IF NOT EXISTS idx_rss_item_chunks_embedding
  ON rss.item_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ── Run observability ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rss.ingest_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  stats       JSONB NOT NULL DEFAULT '{}'::jsonb,
  error       TEXT,
  CONSTRAINT rss_ingest_runs_kind_check CHECK (kind IN ('poll', 'enrich'))
);

CREATE INDEX IF NOT EXISTS idx_rss_ingest_runs_kind_started
  ON rss.ingest_runs (kind, started_at DESC);
```

- [ ] **Step 3: Let drizzle-kit see the new schema**

In `data-pipeline/drizzle.config.ts`, change the `schemaFilter` line from:

```ts
  schemaFilter: ['analytics'],
```

to:

```ts
  schemaFilter: ['analytics', 'rss'],
```

- [ ] **Step 4: Apply the migration against local Postgres**

Run: `pnpm db:migrate`
Expected: prints `✓ app migrations applied` then `✓ pipeline migrations applied` with no error.

If it fails with `extension "vector" is not available`, the local Postgres image lacks pgvector — switch the local container to `pgvector/pgvector:pg16` and re-run. Do not skip the extension.

- [ ] **Step 5: Verify the objects exist**

Run:

```bash
pnpm tsx -e "
import { createPostgresClientFromEnv } from './src/lib/server/db';
import { config } from 'dotenv';
config({ path: '.env.local' }); config();
const sqlc = createPostgresClientFromEnv({ prepare: false });
const t = await sqlc\`SELECT table_name FROM information_schema.tables WHERE table_schema='rss' ORDER BY 1\`;
console.log(t.map(r => r.table_name));
await sqlc.end();
"
```

Expected: `[ 'feeds', 'ingest_runs', 'item_chunks', 'items' ]`

- [ ] **Step 6: Commit**

```bash
git add data-pipeline/migrations data-pipeline/drizzle.config.ts
git commit -m "feat(rss): add rss schema with feeds, items, chunks and ingest runs"
```

---

### Task 2: Drizzle table definitions

**Files:**
- Modify: `src/lib/db/schema.ts` (append at end of file)
- Modify: `src/lib/repositories/types.ts` (TableMap)

**Interfaces:**
- Consumes: the SQL objects from Task 1.
- Produces: exported Drizzle tables `rssFeeds`, `rssItems`, `rssItemChunks`, `rssIngestRuns`; exported types `RssCategory`, `RssFeedTier`, `RssFeedStatus`, `RssRelevance`, `RssContentStatus`, `RSS_CATEGORIES`; TableMap keys `rss_feeds`, `rss_items`, `rss_item_chunks`, `rss_ingest_runs` so `Tables<'rss_items'>` resolves.

- [ ] **Step 1: Confirm the `vector` column type is importable**

Run: `pnpm tsx -e "import { vector } from 'drizzle-orm/pg-core'; console.log(typeof vector)"`
Expected: `function`

If it prints `undefined`, drizzle-orm is too old — stop and report; the plan assumes `^0.45.2` which has it.

- [ ] **Step 2: Add the schema declaration and tables**

Append to the end of `src/lib/db/schema.ts`:

```ts
// ── Data Navigator RSS news lake (schema `rss`) ─────────────────────────────
// Pipeline-owned and GLOBAL: no workspace_id anywhere. The feed catalog and
// the ingested news are shared by every workspace by design.
//
// Indexes and CHECK constraints live in the hand-authored SQL migration
// (data-pipeline/migrations/*_rss_schema.sql), not here — the HNSW vector
// index has no Drizzle expression, and keeping all of them in one place beats
// splitting them across two sources of truth.
export const rss = pgSchema("rss");

export const RSS_CATEGORIES = [
  "expert_insights",
  "market_assessment",
  "new_funding",
  "ma_partnerships",
  "industry_reports",
] as const;
export type RssCategory = (typeof RSS_CATEGORIES)[number];

export type RssFeedTier = "curated" | "query";
export type RssFeedStatus = "active" | "paused" | "dead";
export type RssRelevance = "pending" | "selected" | "rejected";
export type RssContentStatus = "none" | "pending" | "fetched" | "failed";

export const rssFeeds = rss.table("feeds", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  category: text().$type<RssCategory>().notNull(),
  source_name: text().notNull(),
  feed_url: text().notNull(),
  region: text(),
  tier: text().$type<RssFeedTier>().default("curated").notNull(),
  status: text().$type<RssFeedStatus>().default("active").notNull(),
  notes: text(),
  etag: text(),
  last_modified: text(),
  last_polled_at: timestamp({ withTimezone: true, mode: "string" }),
  last_success_at: timestamp({ withTimezone: true, mode: "string" }),
  consecutive_failures: integer().default(0).notNull(),
  created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
  updated_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

export const rssItems = rss.table("items", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  item_hash: text().notNull(),
  feed_id: uuid(),
  category: text().$type<RssCategory>().notNull(),
  source_name: text().notNull(),
  region: text(),
  feed_tier: text().$type<RssFeedTier>().default("curated").notNull(),
  title: text().notNull(),
  link: text().notNull(),
  summary: text(),
  authors: text(),
  tags: text(),
  published_at: timestamp({ withTimezone: true, mode: "string" }),
  ingested_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
  relevance: text().$type<RssRelevance>().default("pending").notNull(),
  relevance_score: real(),
  llm_labels: jsonb().$type<RssItemLabels>(),
  classified_at: timestamp({ withTimezone: true, mode: "string" }),
  content_status: text().$type<RssContentStatus>().default("none").notNull(),
  content_text: text(),
  content_fetched_at: timestamp({ withTimezone: true, mode: "string" }),
  content_attempts: integer().default(0).notNull(),
  content_error: text(),
  embedded_at: timestamp({ withTimezone: true, mode: "string" }),
});

/** Shape written into `rss.items.llm_labels` by the classification stage. */
export interface RssItemLabels {
  companies: string[];
  topics: string[];
  reason: string;
}

export const rssItemChunks = rss.table("item_chunks", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  item_id: uuid().notNull(),
  chunk_index: integer().notNull(),
  text: text().notNull(),
  embedding: vector({ dimensions: 1024 }).notNull(),
  created_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

export const rssIngestRuns = rss.table("ingest_runs", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  kind: text().$type<"poll" | "enrich">().notNull(),
  started_at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
  finished_at: timestamp({ withTimezone: true, mode: "string" }),
  stats: jsonb().default({}).notNull(),
  error: text(),
});
```

- [ ] **Step 3: Add `real` and `vector` to the pg-core import**

The import block at the top of `src/lib/db/schema.ts` already lists `pgTable, pgSchema, pgView, index, ... numeric, varchar, boolean, date, pgEnum, primaryKey, type AnyPgColumn`. Add `real` and `vector` to it. After editing, the first import statement must contain both identifiers — verify with:

Run: `grep -n "  real,\|  vector," src/lib/db/schema.ts | head -2`
Expected: two lines, both within the first 15 lines of the file.

- [ ] **Step 4: Register the tables in TableMap**

In `src/lib/repositories/types.ts`, inside the `TableMap` type, add these four entries (keep the existing alphabetical-ish grouping — append them at the end, before the closing `}`):

```ts
  rss_feeds: typeof schema.rssFeeds;
  rss_items: typeof schema.rssItems;
  rss_item_chunks: typeof schema.rssItemChunks;
  rss_ingest_runs: typeof schema.rssIngestRuns;
```

- [ ] **Step 5: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: exits 0 with no errors.

A common failure here is `Property 'rssFeeds' does not exist on type ...` in `types.ts` — that means Step 2's tables were added after the file's final export or inside another block. They must be at top level.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/schema.ts src/lib/repositories/types.ts
git commit -m "feat(rss): add drizzle definitions for the rss schema"
```

---

### Task 3: `RssFeedRepository`

**Files:**
- Create: `src/lib/repositories/rssFeedRepository.ts`
- Create: `src/lib/repositories/rssFeedRepository.test.ts`
- Modify: `src/lib/repositories/index.ts`

**Interfaces:**
- Consumes: `rssFeeds` table, `RssCategory`/`RssFeedStatus`/`RssFeedTier` types from Task 2.
- Produces:
  - `class RssFeedRepository { constructor(db: DbClient) }`
  - `list(filters?: RssFeedFilters): Promise<Tables<'rss_feeds'>[]>`
  - `findById(id: string): Promise<Tables<'rss_feeds'> | undefined>`
  - `findByUrl(feedUrl: string): Promise<Tables<'rss_feeds'> | undefined>`
  - `insert(data: RssFeedInput): Promise<Tables<'rss_feeds'>>`
  - `update(id, updates: Partial<RssFeedInput>): Promise<Tables<'rss_feeds'> | undefined>`
  - `delete(id: string): Promise<void>`
  - `bulkUpsert(rows: RssFeedInput[]): Promise<number>`
  - `interface RssFeedFilters { categories?: RssCategory[]; statuses?: RssFeedStatus[] }`
  - `interface RssFeedInput { category; source_name; feed_url; region?; tier?; status?; notes? }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/repositories/rssFeedRepository.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RssFeedRepository } from './rssFeedRepository';

const selectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn(),
  limit: vi.fn(),
};
const insertChain = {
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn().mockReturnThis(),
  returning: vi.fn(),
};
const updateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  returning: vi.fn(),
};
const deleteChain = {
  where: vi.fn(),
};

const mockDb = {
  select: vi.fn().mockReturnValue(selectChain),
  insert: vi.fn().mockReturnValue(insertChain),
  update: vi.fn().mockReturnValue(updateChain),
  delete: vi.fn().mockReturnValue(deleteChain),
};

function resetDb() {
  vi.clearAllMocks();
  mockDb.select.mockReturnValue(selectChain);
  mockDb.insert.mockReturnValue(insertChain);
  mockDb.update.mockReturnValue(updateChain);
  mockDb.delete.mockReturnValue(deleteChain);
  selectChain.from.mockReturnThis();
  selectChain.where.mockReturnThis();
  insertChain.values.mockReturnThis();
  insertChain.onConflictDoUpdate.mockReturnThis();
  updateChain.set.mockReturnThis();
  updateChain.where.mockReturnThis();
}

describe('RssFeedRepository.list', () => {
  let repo: RssFeedRepository;

  beforeEach(() => {
    resetDb();
    repo = new RssFeedRepository(mockDb as never);
  });

  it('returns every feed ordered by category then source when no filters are given', async () => {
    selectChain.orderBy.mockResolvedValueOnce([{ id: 'f1' }]);

    const rows = await repo.list();

    expect(rows).toEqual([{ id: 'f1' }]);
    // No filters means no WHERE clause at all, not `WHERE true`.
    expect(selectChain.where).not.toHaveBeenCalled();
    expect(selectChain.orderBy).toHaveBeenCalledTimes(1);
  });

  it('applies a WHERE clause when categories are given', async () => {
    selectChain.orderBy.mockResolvedValueOnce([]);

    await repo.list({ categories: ['new_funding'] });

    expect(selectChain.where).toHaveBeenCalledTimes(1);
  });

  it('returns [] without querying when a filter array is empty', async () => {
    const rows = await repo.list({ categories: [] });

    expect(rows).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

describe('RssFeedRepository.bulkUpsert', () => {
  let repo: RssFeedRepository;

  beforeEach(() => {
    resetDb();
    repo = new RssFeedRepository(mockDb as never);
  });

  it('returns 0 without touching the DB for an empty batch', async () => {
    expect(await repo.bulkUpsert([])).toBe(0);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('upserts on feed_url and returns the affected row count', async () => {
    insertChain.returning.mockResolvedValueOnce([{ id: 'f1' }, { id: 'f2' }]);

    const count = await repo.bulkUpsert([
      { category: 'new_funding', source_name: 'A', feed_url: 'https://a/rss' },
      { category: 'new_funding', source_name: 'B', feed_url: 'https://b/rss' },
    ]);

    expect(count).toBe(2);
    expect(insertChain.values).toHaveBeenCalledTimes(1);
    expect(insertChain.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    // Defaults must be materialised so the CHECK constraints are satisfied.
    const values = insertChain.values.mock.calls[0][0];
    expect(values[0]).toMatchObject({ tier: 'curated', status: 'active' });
  });
});

describe('RssFeedRepository.update', () => {
  let repo: RssFeedRepository;

  beforeEach(() => {
    resetDb();
    repo = new RssFeedRepository(mockDb as never);
  });

  it('stamps updated_at alongside the caller-supplied fields', async () => {
    updateChain.returning.mockResolvedValueOnce([{ id: 'f1', status: 'paused' }]);

    const row = await repo.update('f1', { status: 'paused' });

    expect(row).toEqual({ id: 'f1', status: 'paused' });
    const setArg = updateChain.set.mock.calls[0][0];
    expect(setArg.status).toBe('paused');
    expect(setArg.updated_at).toBeDefined();
  });

  it('returns undefined when the id does not exist', async () => {
    updateChain.returning.mockResolvedValueOnce([]);
    expect(await repo.update('nope', { status: 'paused' })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/repositories/rssFeedRepository.test.ts`
Expected: FAIL — `Failed to resolve import "./rssFeedRepository"`.

- [ ] **Step 3: Write the repository**

Create `src/lib/repositories/rssFeedRepository.ts`:

```ts
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { rssFeeds } from '@/lib/db/schema';
import type { RssCategory, RssFeedStatus, RssFeedTier } from '@/lib/db/schema';
import type { DbClient, Tables } from './types';

export interface RssFeedFilters {
  categories?: RssCategory[];
  statuses?: RssFeedStatus[];
}

/** Caller-supplied feed fields. Health columns are pipeline-owned, never set here. */
export interface RssFeedInput {
  category: RssCategory;
  source_name: string;
  feed_url: string;
  region?: string | null;
  tier?: RssFeedTier;
  status?: RssFeedStatus;
  notes?: string | null;
}

/**
 * The global RSS feed catalog. Deliberately NOT workspace-scoped: news sources
 * are shared across every workspace, so there is no `workspaceId` in the
 * constructor and no tenant predicate in any query.
 */
export class RssFeedRepository {
  constructor(private readonly db: DbClient) {}

  async list(filters: RssFeedFilters = {}): Promise<Tables<'rss_feeds'>[]> {
    const conditions = [];
    if (filters.categories !== undefined) {
      // An explicitly empty filter matches nothing; `inArray` with an empty
      // array crashes Drizzle, so short-circuit instead.
      if (filters.categories.length === 0) return [];
      conditions.push(inArray(rssFeeds.category, filters.categories));
    }
    if (filters.statuses !== undefined) {
      if (filters.statuses.length === 0) return [];
      conditions.push(inArray(rssFeeds.status, filters.statuses));
    }

    const query = this.db.select().from(rssFeeds);
    const filtered = conditions.length > 0 ? query.where(and(...conditions)) : query;
    return filtered.orderBy(asc(rssFeeds.category), asc(rssFeeds.source_name));
  }

  async findById(id: string): Promise<Tables<'rss_feeds'> | undefined> {
    const [row] = await this.db.select().from(rssFeeds).where(eq(rssFeeds.id, id)).limit(1);
    return row;
  }

  async findByUrl(feedUrl: string): Promise<Tables<'rss_feeds'> | undefined> {
    const [row] = await this.db
      .select()
      .from(rssFeeds)
      .where(eq(rssFeeds.feed_url, feedUrl))
      .limit(1);
    return row;
  }

  async insert(data: RssFeedInput): Promise<Tables<'rss_feeds'>> {
    const [row] = await this.db.insert(rssFeeds).values(withDefaults(data)).returning();
    return row;
  }

  async update(
    id: string,
    updates: Partial<RssFeedInput>,
  ): Promise<Tables<'rss_feeds'> | undefined> {
    const [row] = await this.db
      .update(rssFeeds)
      .set({ ...updates, updated_at: sql`now()` })
      .where(eq(rssFeeds.id, id))
      .returning();
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(rssFeeds).where(eq(rssFeeds.id, id));
  }

  /**
   * Idempotent catalog import keyed on `feed_url`. Re-importing the CSV
   * refreshes the editorial columns but never resets health state
   * (etag/last_polled_at/consecutive_failures) — that belongs to the poller.
   * Returns the number of rows inserted or updated.
   */
  async bulkUpsert(rows: RssFeedInput[]): Promise<number> {
    if (rows.length === 0) return 0;
    const affected = await this.db
      .insert(rssFeeds)
      .values(rows.map(withDefaults))
      .onConflictDoUpdate({
        target: rssFeeds.feed_url,
        set: {
          category: sql`excluded.category`,
          source_name: sql`excluded.source_name`,
          region: sql`excluded.region`,
          tier: sql`excluded.tier`,
          status: sql`excluded.status`,
          notes: sql`excluded.notes`,
          updated_at: sql`now()`,
        },
      })
      .returning({ id: rssFeeds.id });
    return affected.length;
  }
}

function withDefaults(data: RssFeedInput) {
  return {
    category: data.category,
    source_name: data.source_name,
    feed_url: data.feed_url,
    region: data.region ?? null,
    tier: data.tier ?? ('curated' as const),
    status: data.status ?? ('active' as const),
    notes: data.notes ?? null,
  };
}
```

- [ ] **Step 4: Export from the barrel**

Append to `src/lib/repositories/index.ts`:

```ts
export * from './rssFeedRepository';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/repositories/rssFeedRepository.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/repositories/rssFeedRepository.ts src/lib/repositories/rssFeedRepository.test.ts src/lib/repositories/index.ts
git commit -m "feat(rss): add global RssFeedRepository with idempotent bulk upsert"
```

---

### Task 4: `RssFeedService`, container wiring, and admin routes

**Files:**
- Create: `src/lib/services/rssFeedService.ts`
- Create: `src/lib/services/rssFeedService.test.ts`
- Create: `src/app/api/auth/rss-feeds/route.ts`
- Create: `src/app/api/auth/rss-feeds/import/route.ts`
- Create: `src/app/api/auth/rss-feeds/[id]/route.ts`
- Modify: `src/lib/services/container.ts`
- Modify: `src/proxy.ts`

**Interfaces:**
- Consumes: `RssFeedRepository`, `RssFeedInput`, `RssFeedFilters` from Task 3.
- Produces:
  - `class RssFeedService { constructor(rssFeedRepo: RssFeedRepository) }`
  - `listFeeds(filters?: RssFeedFilters)`, `createFeed(input)`, `updateFeed(id, updates)`, `deleteFeed(id)`, `importFeeds(rows: unknown[]): Promise<{ imported: number; skipped: RssFeedImportError[] }>`
  - `class RssFeedNotFoundError extends Error`
  - `interface RssFeedImportError { index: number; reason: string }`
  - Container key `rssFeedService`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/services/rssFeedService.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RssFeedService, RssFeedNotFoundError } from './rssFeedService';
import type { RssFeedRepository } from '@/lib/repositories';

describe('RssFeedService', () => {
  let repo: {
    list: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    bulkUpsert: ReturnType<typeof vi.fn>;
  };
  let service: RssFeedService;

  beforeEach(() => {
    repo = {
      list: vi.fn(),
      findById: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      bulkUpsert: vi.fn(),
    };
    service = new RssFeedService(repo as unknown as RssFeedRepository);
  });

  it('listFeeds delegates to repo.list', async () => {
    repo.list.mockResolvedValueOnce([{ id: 'f1' }]);
    expect(await service.listFeeds({ statuses: ['active'] })).toEqual([{ id: 'f1' }]);
    expect(repo.list).toHaveBeenCalledWith({ statuses: ['active'] });
  });

  it('updateFeed throws RssFeedNotFoundError when the row is missing', async () => {
    repo.update.mockResolvedValueOnce(undefined);
    await expect(service.updateFeed('missing', { status: 'paused' })).rejects.toBeInstanceOf(
      RssFeedNotFoundError,
    );
  });

  it('deleteFeed refuses to delete a feed that does not exist', async () => {
    repo.findById.mockResolvedValueOnce(undefined);
    await expect(service.deleteFeed('missing')).rejects.toBeInstanceOf(RssFeedNotFoundError);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('importFeeds upserts valid rows and reports invalid ones without aborting', async () => {
    repo.bulkUpsert.mockResolvedValueOnce(1);

    const result = await service.importFeeds([
      { category: 'new_funding', source_name: 'Mint', feed_url: 'https://mint/rss' },
      { category: 'not_a_category', source_name: 'X', feed_url: 'https://x/rss' },
      { category: 'new_funding', source_name: 'Y' },
    ]);

    expect(result.imported).toBe(1);
    expect(result.skipped).toEqual([
      { index: 1, reason: 'unknown category "not_a_category"' },
      { index: 2, reason: 'feed_url is required' },
    ]);
    expect(repo.bulkUpsert).toHaveBeenCalledWith([
      {
        category: 'new_funding',
        source_name: 'Mint',
        feed_url: 'https://mint/rss',
        region: null,
        tier: 'curated',
        status: 'active',
        notes: null,
      },
    ]);
  });

  it('importFeeds defaults tier to query for Google/Bing News URLs', async () => {
    repo.bulkUpsert.mockResolvedValueOnce(1);

    await service.importFeeds([
      {
        category: 'ma_partnerships',
        source_name: 'Google News: M&A',
        feed_url: 'https://news.google.com/rss/search?q=acquisition',
      },
    ]);

    expect(repo.bulkUpsert.mock.calls[0][0][0].tier).toBe('query');
  });

  it('importFeeds honours an explicit tier over the URL heuristic', async () => {
    repo.bulkUpsert.mockResolvedValueOnce(1);

    await service.importFeeds([
      {
        category: 'ma_partnerships',
        source_name: 'Google News: M&A',
        feed_url: 'https://news.google.com/rss/search?q=acquisition',
        tier: 'curated',
      },
    ]);

    expect(repo.bulkUpsert.mock.calls[0][0][0].tier).toBe('curated');
  });

  it('importFeeds does not call the repository when every row is invalid', async () => {
    const result = await service.importFeeds([{ nonsense: true }]);
    expect(result.imported).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(repo.bulkUpsert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/services/rssFeedService.test.ts`
Expected: FAIL — cannot resolve `./rssFeedService`.

- [ ] **Step 3: Write the service**

Create `src/lib/services/rssFeedService.ts`:

```ts
import { RSS_CATEGORIES } from '@/lib/db/schema';
import type { RssCategory, RssFeedStatus, RssFeedTier } from '@/lib/db/schema';
import type {
  RssFeedFilters,
  RssFeedInput,
  RssFeedRepository,
  Tables,
} from '@/lib/repositories';

export class RssFeedNotFoundError extends Error {
  constructor(id: string) {
    super(`RSS feed ${id} not found`);
    this.name = 'RssFeedNotFoundError';
  }
}

export interface RssFeedImportError {
  index: number;
  reason: string;
}

export interface RssFeedImportResult {
  imported: number;
  skipped: RssFeedImportError[];
}

const TIERS: RssFeedTier[] = ['curated', 'query'];
const STATUSES: RssFeedStatus[] = ['active', 'paused', 'dead'];

/**
 * Keyword-query aggregator feeds (Google News / Bing News searches) carry a
 * lower trust weight than a publisher's own feed, and the classifier holds
 * them to a higher relevance bar. Detect them from the URL so a 263-row CSV
 * import doesn't have to hand-label every row.
 */
function inferTier(feedUrl: string): RssFeedTier {
  return /(^|\.)news\.google\.com|(^|\.)bing\.com\/news/i.test(feedUrl) ? 'query' : 'curated';
}

export class RssFeedService {
  constructor(private readonly rssFeedRepo: RssFeedRepository) {}

  listFeeds(filters: RssFeedFilters = {}): Promise<Tables<'rss_feeds'>[]> {
    return this.rssFeedRepo.list(filters);
  }

  createFeed(input: RssFeedInput): Promise<Tables<'rss_feeds'>> {
    return this.rssFeedRepo.insert(input);
  }

  async updateFeed(
    id: string,
    updates: Partial<RssFeedInput>,
  ): Promise<Tables<'rss_feeds'>> {
    const row = await this.rssFeedRepo.update(id, updates);
    if (!row) throw new RssFeedNotFoundError(id);
    return row;
  }

  async deleteFeed(id: string): Promise<void> {
    const existing = await this.rssFeedRepo.findById(id);
    if (!existing) throw new RssFeedNotFoundError(id);
    await this.rssFeedRepo.delete(id);
  }

  /**
   * Bulk catalog import. Invalid rows are reported rather than thrown so a
   * single bad line in a 263-row CSV can't block the other 262.
   */
  async importFeeds(rows: unknown[]): Promise<RssFeedImportResult> {
    const valid: RssFeedInput[] = [];
    const skipped: RssFeedImportError[] = [];

    rows.forEach((raw, index) => {
      const parsed = parseFeedRow(raw);
      if ('reason' in parsed) {
        skipped.push({ index, reason: parsed.reason });
        return;
      }
      valid.push(parsed.value);
    });

    const imported = valid.length > 0 ? await this.rssFeedRepo.bulkUpsert(valid) : 0;
    return { imported, skipped };
  }
}

type ParseResult = { value: RssFeedInput } | { reason: string };

function parseFeedRow(raw: unknown): ParseResult {
  if (typeof raw !== 'object' || raw === null) return { reason: 'row is not an object' };
  const row = raw as Record<string, unknown>;

  const category = str(row.category);
  if (!category) return { reason: 'category is required' };
  if (!(RSS_CATEGORIES as readonly string[]).includes(category)) {
    return { reason: `unknown category "${category}"` };
  }

  const sourceName = str(row.source_name);
  if (!sourceName) return { reason: 'source_name is required' };

  const feedUrl = str(row.feed_url);
  if (!feedUrl) return { reason: 'feed_url is required' };
  if (!/^https?:\/\//i.test(feedUrl)) return { reason: `feed_url must be http(s): "${feedUrl}"` };

  const tier = str(row.tier);
  if (tier && !TIERS.includes(tier as RssFeedTier)) {
    return { reason: `unknown tier "${tier}"` };
  }

  const status = str(row.status);
  if (status && !STATUSES.includes(status as RssFeedStatus)) {
    return { reason: `unknown status "${status}"` };
  }

  return {
    value: {
      category: category as RssCategory,
      source_name: sourceName,
      feed_url: feedUrl,
      region: str(row.region) ?? null,
      tier: (tier as RssFeedTier | undefined) ?? inferTier(feedUrl),
      status: (status as RssFeedStatus | undefined) ?? 'active',
      notes: str(row.notes) ?? null,
    },
  };
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/services/rssFeedService.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Wire the service into the container**

`src/lib/services/container.ts` needs four edits:

1. Add `RssFeedRepository` to the big named import block from `'@/lib/repositories'` (append after `FeedbackRepository,`).
2. Add the service import next to the other service imports:

```ts
import { RssFeedService } from './rssFeedService';
```

3. Add the field to the `Container` interface, after `tableLayoutService: TableLayoutService;`:

```ts
  rssFeedService: RssFeedService;
```

4. In `createContainer`, next to the other simple wirings near the end (after the `feedbackRepo` / `feedbackService` pair), add:

```ts
  // Global (non-workspace-scoped): the RSS feed catalog is shared by every
  // workspace, so the repo takes no workspaceId.
  const rssFeedRepo = new RssFeedRepository(db);
  const rssFeedService = new RssFeedService(rssFeedRepo);
```

and add `rssFeedService,` to the returned object literal.

- [ ] **Step 6: Register the admin paths in the proxy gate**

In `src/proxy.ts`, change the `ADMIN_ROUTES` constant from:

```ts
const ADMIN_ROUTES = new Set(['/api/auth/signup', '/api/auth/api-keys']);
```

to:

```ts
const ADMIN_ROUTES = new Set([
  '/api/auth/signup',
  '/api/auth/api-keys',
  '/api/auth/rss-feeds',
]);
```

and in `classifyApiRoute`, extend the prefix test from:

```ts
  if (ADMIN_ROUTES.has(pathname) || pathname.startsWith('/api/auth/api-keys/')) {
    return 'secret';
  }
```

to:

```ts
  if (
    ADMIN_ROUTES.has(pathname) ||
    pathname.startsWith('/api/auth/api-keys/') ||
    pathname.startsWith('/api/auth/rss-feeds/')
  ) {
    return 'secret';
  }
```

- [ ] **Step 7: Add a proxy classification test**

`src/proxy.test.ts` already exists and tests `classifyApiRoute`. Append this describe block to it:

```ts
describe('classifyApiRoute — rss feed admin routes', () => {
  it('gates the rss-feeds collection behind the shared secret', () => {
    expect(classifyApiRoute('/api/auth/rss-feeds')).toBe('secret');
  });

  it('gates rss-feeds sub-paths behind the shared secret', () => {
    expect(classifyApiRoute('/api/auth/rss-feeds/import')).toBe('secret');
    expect(classifyApiRoute('/api/auth/rss-feeds/abc-123')).toBe('secret');
  });

  it('leaves the rest of /api/auth open for NextAuth', () => {
    expect(classifyApiRoute('/api/auth/session')).toBe('allow');
  });
});
```

If `src/proxy.test.ts` does not exist, create it with the imports `import { describe, it, expect } from 'vitest';` and `import { classifyApiRoute } from './proxy';` above that block.

- [ ] **Step 8: Write the collection route**

Create `src/app/api/auth/rss-feeds/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { RSS_CATEGORIES } from '@/lib/db/schema';
import type { RssCategory, RssFeedStatus } from '@/lib/db/schema';

/**
 * Admin management of the GLOBAL RSS feed catalog. Gated by the shared-secret
 * `proxy.ts` middleware (`X-Api-Secret` vs `ADMIN_SECRET`) — there is no
 * session check here by design.
 *
 *   GET  /api/auth/rss-feeds?category=…&status=…  — list with health columns
 *   POST /api/auth/rss-feeds                      — create one feed
 */
export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const categories = splitEnum<RssCategory>(params.get('category'), RSS_CATEGORIES);
    const statuses = splitEnum<RssFeedStatus>(params.get('status'), [
      'active',
      'paused',
      'dead',
    ]);

    const db = createDb();
    const { rssFeedService } = createContainer(db, await getActiveWorkspaceId());
    const data = await rssFeedService.listFeeds({ categories, statuses });
    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => undefined);
    const db = createDb();
    const { rssFeedService } = createContainer(db, await getActiveWorkspaceId());

    // Reuse the import validator for a single row so create and bulk-import
    // enforce exactly the same rules.
    const { imported, skipped } = await rssFeedService.importFeeds([body]);
    if (skipped.length > 0) {
      return NextResponse.json({ error: skipped[0].reason }, { status: 400 });
    }
    return NextResponse.json({ data: { imported } }, { status: 201 });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

function splitEnum<T extends string>(
  raw: string | null,
  allowed: readonly string[],
): T[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => allowed.includes(value)) as T[];
}
```

- [ ] **Step 9: Write the import route**

Create `src/app/api/auth/rss-feeds/import/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

/**
 * Bulk, idempotent catalog import — the seeding path for staging/production.
 * Body: `{ "feeds": [ { category, source_name, feed_url, region?, tier?, ... } ] }`
 * Upserts on `feed_url`; invalid rows are reported in `skipped`, not thrown.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => undefined);
    const feeds = (body as { feeds?: unknown } | undefined)?.feeds;
    if (!Array.isArray(feeds)) {
      return NextResponse.json({ error: 'feeds must be an array' }, { status: 400 });
    }

    const db = createDb();
    const { rssFeedService } = createContainer(db, await getActiveWorkspaceId());
    const data = await rssFeedService.importFeeds(feeds);
    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
```

- [ ] **Step 10: Write the per-feed route**

Create `src/app/api/auth/rss-feeds/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { RssFeedNotFoundError } from '@/lib/services/rssFeedService';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const updates = await req.json().catch(() => undefined);
    if (typeof updates !== 'object' || updates === null) {
      return NextResponse.json({ error: 'body must be an object' }, { status: 400 });
    }

    const db = createDb();
    const { rssFeedService } = createContainer(db, await getActiveWorkspaceId());
    const data = await rssFeedService.updateFeed(id, updates);
    return NextResponse.json({ data });
  } catch (err) {
    if (err instanceof RssFeedNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const db = createDb();
    const { rssFeedService } = createContainer(db, await getActiveWorkspaceId());
    await rssFeedService.deleteFeed(id);
    return NextResponse.json({ data: { success: true } });
  } catch (err) {
    if (err instanceof RssFeedNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
```

- [ ] **Step 11: Typecheck and run the suite**

Run: `pnpm tsc --noEmit && pnpm vitest run src/lib/services/rssFeedService.test.ts src/proxy.test.ts`
Expected: tsc exits 0; both test files PASS.

- [ ] **Step 12: Commit**

```bash
git add src/lib/services/rssFeedService.ts src/lib/services/rssFeedService.test.ts \
        src/lib/services/container.ts src/proxy.ts src/proxy.test.ts \
        src/app/api/auth/rss-feeds
git commit -m "feat(rss): add RssFeedService and secret-gated feed admin API"
```

---

### Task 5: Feed catalog fixture and local seed

**Files:**
- Create: `data-pipeline/fixtures/rss-feeds.csv` (copied from the PoC)
- Create: `scripts/import-rss-feeds.ts`
- Modify: `scripts/seed.ts`

**Interfaces:**
- Consumes: `POST /api/auth/rss-feeds/import` from Task 4; `rssFeeds` table from Task 2.
- Produces: `pnpm rss:import-feeds` CLI; `seedRssFeeds(db)` called from `scripts/seed.ts`'s `main()`.

- [ ] **Step 1: Copy the validated catalog into the repo**

```bash
mkdir -p data-pipeline/fixtures
cp /Users/nico/Downloads/rss-lake-poc/feeds_final.csv data-pipeline/fixtures/rss-feeds.csv
head -1 data-pipeline/fixtures/rss-feeds.csv
wc -l data-pipeline/fixtures/rss-feeds.csv
```

Expected header: `category,source_name,feed_url,region,notes,status,entries`
Expected line count: 264 (263 feeds + header).

Note the CSV's `status` column is the PoC's *validation* status (`OK`/`REPAIRED`/`DEAD`), which is NOT the same vocabulary as `rss.feeds.status` (`active`/`paused`/`dead`). The importer in Step 2 translates it.

- [ ] **Step 2: Write the importer CLI**

Create `scripts/import-rss-feeds.ts`:

```ts
/**
 * Import the validated RSS feed catalog into rss.feeds via the admin API.
 *
 * Usage:
 *   pnpm rss:import-feeds                       # against http://localhost:3000
 *   pnpm rss:import-feeds --base https://staging.example.com
 *   pnpm rss:import-feeds --file path/to.csv
 *
 * Idempotent: the endpoint upserts on feed_url, so re-running only refreshes
 * editorial columns and never disturbs poller health state.
 */
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

config({ path: '.env.local' });
config();

const DEFAULT_FILE = 'data-pipeline/fixtures/rss-feeds.csv';

/** Minimal RFC4180 line splitter: handles quoted fields containing commas. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim().length > 0));
  if (!header) return [];
  return body.map((cells) =>
    Object.fromEntries(header.map((key, i) => [key.trim(), (cells[i] ?? '').trim()])),
  );
}

/**
 * The PoC CSV's `status` column is a *validation* verdict, not our lifecycle
 * status. OK/REPAIRED/blank become `active`; anything else (DEAD, ERROR) is
 * imported as `dead` so it is on record without being polled.
 */
export function toFeedInput(row: Record<string, string>) {
  const validation = (row.status ?? '').toUpperCase();
  const status = validation === '' || validation === 'OK' || validation === 'REPAIRED'
    ? 'active'
    : 'dead';
  return {
    category: row.category,
    source_name: row.source_name,
    feed_url: row.feed_url,
    region: row.region || null,
    notes: row.notes || null,
    status,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const fileArg = args[args.indexOf('--file') + 1];
  const baseArg = args[args.indexOf('--base') + 1];
  const file = args.includes('--file') && fileArg ? fileArg : DEFAULT_FILE;
  const base = args.includes('--base') && baseArg ? baseArg : 'http://localhost:3000';

  const secret = process.env.ADMIN_SECRET;
  if (!secret) throw new Error('ADMIN_SECRET is required to call the admin import endpoint');

  const csv = readFileSync(resolve(process.cwd(), file), 'utf8');
  const feeds = parseCsv(csv).map(toFeedInput);
  console.log(`parsed ${feeds.length} feeds from ${file}`);

  const res = await fetch(`${base}/api/auth/rss-feeds/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Secret': secret },
    body: JSON.stringify({ feeds }),
  });
  const payload = (await res.json()) as {
    data?: { imported: number; skipped: { index: number; reason: string }[] };
    error?: string;
  };
  if (!res.ok) throw new Error(payload.error ?? `import failed (${res.status})`);

  const { imported = 0, skipped = [] } = payload.data ?? {};
  console.log(`✓ imported ${imported} feeds`);
  if (skipped.length > 0) {
    console.log(`  skipped ${skipped.length}:`);
    for (const s of skipped.slice(0, 20)) console.log(`    row ${s.index}: ${s.reason}`);
  }
}

main().catch((err) => {
  console.error('import failed:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Test the CSV parser**

Create `scripts/import-rss-feeds.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseCsv, toFeedInput } from './import-rss-feeds';

describe('parseCsv', () => {
  it('maps each row onto the header keys', () => {
    const rows = parseCsv('category,source_name\nnew_funding,Mint\n');
    expect(rows).toEqual([{ category: 'new_funding', source_name: 'Mint' }]);
  });

  it('keeps commas that appear inside quoted fields', () => {
    const rows = parseCsv('source_name,notes\n"Reuters","Wire, global"\n');
    expect(rows[0].notes).toBe('Wire, global');
  });

  it('unescapes doubled quotes', () => {
    const rows = parseCsv('source_name\n"The ""Economist"""\n');
    expect(rows[0].source_name).toBe('The "Economist"');
  });

  it('ignores blank trailing lines', () => {
    expect(parseCsv('a,b\n1,2\n\n')).toHaveLength(1);
  });
});

describe('toFeedInput', () => {
  it('treats OK and REPAIRED validation verdicts as active feeds', () => {
    expect(toFeedInput({ status: 'OK' } as never).status).toBe('active');
    expect(toFeedInput({ status: 'REPAIRED' } as never).status).toBe('active');
    expect(toFeedInput({} as never).status).toBe('active');
  });

  it('imports failed feeds as dead so they are on record but never polled', () => {
    expect(toFeedInput({ status: 'DEAD' } as never).status).toBe('dead');
  });

  it('normalises empty optional columns to null', () => {
    const input = toFeedInput({ category: 'new_funding', region: '', notes: '' } as never);
    expect(input.region).toBeNull();
    expect(input.notes).toBeNull();
  });
});
```

Run: `pnpm vitest run scripts/import-rss-feeds.test.ts`
Expected: PASS — 7 tests.

If vitest does not pick up `scripts/**`, check the root `vitest.config.ts` `include` glob and add `'scripts/**/*.test.ts'` to it.

- [ ] **Step 4: Add the pnpm script**

In the root `package.json` `scripts` block, after `"db:seed:neo4j"`, add:

```json
    "rss:import-feeds": "tsx scripts/import-rss-feeds.ts",
```

- [ ] **Step 5: Seed a representative subset locally**

`scripts/seed.ts` must gain a `seedRssFeeds` function. Add these imports to its existing import block (merge into the existing `@/lib/db/schema` import rather than adding a second one):

```ts
import { rssFeeds, rssItems } from '@/lib/db/schema';
```

Add this function above `async function main()`:

```ts
/**
 * A representative slice of the global RSS catalog (3 feeds per category) plus
 * a handful of items, so the Data Navigator page renders locally without
 * running the ingest Lambdas. The full 263-feed catalog is imported separately
 * with `pnpm rss:import-feeds`.
 */
// UUIDs must be valid hex — the `f` prefix below is just a readable marker for
// "RSS feed seed row", not arbitrary text.
const SEED_RSS_FEEDS = [
  { id: '00000000-0000-0000-0000-0000000f0001', category: 'expert_insights', source_name: 'AEI', feed_url: 'https://www.aei.org/feed/', region: 'US', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f0002', category: 'expert_insights', source_name: 'Bank Underground (BoE)', feed_url: 'https://bankunderground.co.uk/feed/', region: 'UK', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f0003', category: 'expert_insights', source_name: 'Bruegel', feed_url: 'https://www.bruegel.org/rss.xml', region: 'EU', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f0004', category: 'market_assessment', source_name: 'SEC Press Releases', feed_url: 'https://www.sec.gov/news/pressreleases.rss', region: 'US', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f0005', category: 'market_assessment', source_name: 'BusinessWire Markets', feed_url: 'https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeGVtRVQ==', region: 'Global', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f0006', category: 'market_assessment', source_name: 'Google News: market share report', feed_url: 'https://news.google.com/rss/search?q=%22market+share%22+report', region: 'Global', tier: 'query' },
  { id: '00000000-0000-0000-0000-0000000f0007', category: 'new_funding', source_name: 'DealStreetAsia', feed_url: 'https://www.dealstreetasia.com/feed', region: 'APAC', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f0008', category: 'new_funding', source_name: 'Mint Companies', feed_url: 'https://www.livemint.com/rss/companies', region: 'India', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f0009', category: 'new_funding', source_name: 'Google News: raises series', feed_url: 'https://news.google.com/rss/search?q=raises+%22series+a%22', region: 'Global', tier: 'query' },
  { id: '00000000-0000-0000-0000-0000000f000a', category: 'ma_partnerships', source_name: 'MarketBeat M&A', feed_url: 'https://www.marketbeat.com/feed/', region: 'US', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f000b', category: 'ma_partnerships', source_name: 'PR Newswire M&A', feed_url: 'https://www.prnewswire.com/rss/financial-services-latest-news/acquisitions-mergers-and-takeovers-list.rss', region: 'US', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f000c', category: 'ma_partnerships', source_name: 'Google News: acquires stake', feed_url: 'https://news.google.com/rss/search?q=acquires+stake', region: 'Global', tier: 'query' },
  { id: '00000000-0000-0000-0000-0000000f000d', category: 'industry_reports', source_name: 'IMF Publications', feed_url: 'https://www.imf.org/en/Publications/RSS', region: 'Global', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f000e', category: 'industry_reports', source_name: 'BIS Research', feed_url: 'https://www.bis.org/doclist/all_rss.rss', region: 'Global', tier: 'curated' },
  { id: '00000000-0000-0000-0000-0000000f000f', category: 'industry_reports', source_name: 'Google News: initiates coverage', feed_url: 'https://news.google.com/rss/search?q=%22initiates+coverage%22', region: 'Global', tier: 'query' },
] as const;

async function seedRssFeeds(db: DbClient) {
  const ids = SEED_RSS_FEEDS.map((f) => f.id);
  // Items cascade from feeds; delete children first anyway so a partial
  // previous seed can't leave orphans behind.
  await db.delete(rssItems).where(inArray(rssItems.feed_id, ids));
  await db.delete(rssFeeds).where(inArray(rssFeeds.id, ids));
  await db.insert(rssFeeds).values(SEED_RSS_FEEDS.map((f) => ({ ...f })));

  const now = Date.now();
  await db.insert(rssItems).values(
    SEED_RSS_FEEDS.flatMap((feed, feedIndex) =>
      [0, 1].map((n) => {
        const index = feedIndex * 2 + n;
        const selected = index % 3 === 0;
        return {
          item_hash: `seed-${feed.id}-${n}`,
          feed_id: feed.id,
          category: feed.category,
          source_name: feed.source_name,
          region: feed.region,
          feed_tier: feed.tier,
          title: `${feed.source_name}: sample headline ${n + 1}`,
          link: `https://example.com/${feed.category}/${index}`,
          summary: `Seeded summary ${n + 1} for ${feed.source_name}. Used to render the Data Navigator locally.`,
          authors: n === 0 ? 'Jane Analyst' : null,
          tags: feed.category,
          // Stagger backwards in time so the newest-first ordering is visible.
          published_at: new Date(now - index * 3_600_000).toISOString(),
          relevance: selected ? ('selected' as const) : ('rejected' as const),
          relevance_score: selected ? 0.82 : 0.21,
          content_status: selected ? ('fetched' as const) : ('none' as const),
          content_text: selected
            ? `Full seeded article body for ${feed.source_name} headline ${n + 1}. `.repeat(40)
            : null,
          content_fetched_at: selected ? new Date(now - index * 3_600_000).toISOString() : null,
        };
      }),
    ),
  );

  console.log(`  seeded ${SEED_RSS_FEEDS.length} rss feeds + ${SEED_RSS_FEEDS.length * 2} items`);
}
```

Then call it from `main()`, next to the existing `await seedFundManagement(...)` line:

```ts
  await seedRssFeeds(db as unknown as DbClient);
```

Note: `inArray` is already imported in `seed.ts` (it is used by `seedFundManagement`). If tsc says otherwise, add it to the `drizzle-orm` import.

- [ ] **Step 6: Run the seeder end to end**

Run: `pnpm db:seed`
Expected: completes without error and prints `seeded 15 rss feeds + 30 items`.

Then verify:

```bash
pnpm tsx -e "
import { config } from 'dotenv';
config({ path: '.env.local' }); config();
const { createPostgresClientFromEnv } = await import('./src/lib/server/db');
const sqlc = createPostgresClientFromEnv({ prepare: false });
console.log(await sqlc\`SELECT category, count(*) FROM rss.items GROUP BY 1 ORDER BY 1\`);
await sqlc.end();
"
```

Expected: five rows, 6 items each.

- [ ] **Step 7: Commit**

```bash
git add data-pipeline/fixtures/rss-feeds.csv scripts/import-rss-feeds.ts \
        scripts/import-rss-feeds.test.ts scripts/seed.ts package.json
git commit -m "feat(rss): add feed catalog fixture, admin importer and local seed data"
```

- [ ] **Step 8: Import the full catalog into local dev (manual verification)**

With `vercel dev` running in another terminal:

```bash
pnpm rss:import-feeds
```

Expected: `parsed 263 feeds from data-pipeline/fixtures/rss-feeds.csv` then `✓ imported 263 feeds` with 0 skipped. Re-run it once — the second run must also report 263 imported (upsert, not duplicate). Confirm with:

```bash
pnpm tsx -e "
import { config } from 'dotenv';
config({ path: '.env.local' }); config();
const { createPostgresClientFromEnv } = await import('./src/lib/server/db');
const sqlc = createPostgresClientFromEnv({ prepare: false });
console.log(await sqlc\`SELECT category, status, count(*) FROM rss.feeds GROUP BY 1,2 ORDER BY 1,2\`);
await sqlc.end();
"
```

Expected: each of the five categories shows ≥50 `active` feeds.

---

**Phase 1 exit criteria:** `rss` schema exists with pgvector + pg_trgm; 263 feeds importable and re-importable idempotently through a secret-gated endpoint; `pnpm db:seed` gives a working local dataset; `pnpm tsc --noEmit` and `pnpm test` both clean.

---

# Phase 2 — Poll pipeline

### Task 6: Feed normalization helpers

**Files:**
- Create: `data-pipeline/src/handlers/rssNormalize.ts`
- Create: `data-pipeline/src/handlers/rssNormalize.test.ts`
- Create: `data-pipeline/fixtures/rss-sample-rss2.xml`
- Create: `data-pipeline/fixtures/rss-sample-atom.xml`
- Modify: `data-pipeline/package.json` (add `rss-parser`)

**Interfaces:**
- Consumes: `RssCategory`, `RssFeedTier` from `@/lib/db/schema`.
- Produces (all pure, no I/O — this is why they are testable without network):
  - `stripHtml(text: string | undefined, limit?: number): string`
  - `itemHash(guid: string): string` — sha256 hex
  - `entryTimestamp(item: RssParserItem): string | null` — ISO 8601 or null
  - `normalizeEntries(feed: FeedRow, parsed: RssParserFeed, maxItems: number): NormalizedItem[]`
  - `interface FeedRow { id; category; source_name; feed_url; region; tier }`
  - `interface NormalizedItem { item_hash; feed_id; category; source_name; region; feed_tier; title; link; summary; authors; tags; published_at }`
  - `const MAX_ITEMS_PER_FEED = 25`, `const SUMMARY_LIMIT = 2000`, `const TITLE_LIMIT = 500`

- [ ] **Step 1: Add the RSS parser dependency**

```bash
pnpm --filter data-pipeline add rss-parser
```

Expected: adds `"rss-parser": "^3.13.0"` to `data-pipeline/package.json` dependencies.

- [ ] **Step 2: Create the feed fixtures**

Create `data-pipeline/fixtures/rss-sample-rss2.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Sample Wire</title>
    <item>
      <title>Acme raises $40m Series B</title>
      <link>https://example.com/acme-series-b</link>
      <guid isPermaLink="false">urn:sample:1</guid>
      <pubDate>Tue, 02 Sep 2026 08:30:00 GMT</pubDate>
      <dc:creator>Jane Analyst</dc:creator>
      <category>funding</category>
      <category>venture</category>
      <description>&lt;p&gt;Acme&amp;nbsp;Corp has &lt;b&gt;closed&lt;/b&gt; a $40m round.&lt;/p&gt;</description>
    </item>
    <item>
      <title>Beta Ltd acquires Gamma</title>
      <link>https://example.com/beta-gamma</link>
      <pubDate>Mon, 01 Sep 2026 12:00:00 GMT</pubDate>
      <description>All-cash deal.</description>
    </item>
    <item>
      <title>Undated note</title>
      <link>https://example.com/undated</link>
      <description>No pubDate on this one.</description>
    </item>
  </channel>
</rss>
```

Create `data-pipeline/fixtures/rss-sample-atom.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Sample Atom Research</title>
  <entry>
    <title>Initiating coverage on Delta Industries</title>
    <link href="https://example.com/delta-initiation"/>
    <id>tag:example.com,2026:delta-initiation</id>
    <updated>2026-09-02T06:00:00Z</updated>
    <author><name>Research Desk</name></author>
    <summary type="html">&lt;p&gt;We initiate at Buy.&lt;/p&gt;</summary>
  </entry>
</feed>
```

- [ ] **Step 3: Write the failing test**

Create `data-pipeline/src/handlers/rssNormalize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Parser from 'rss-parser';
import {
  stripHtml,
  itemHash,
  entryTimestamp,
  normalizeEntries,
  MAX_ITEMS_PER_FEED,
  type FeedRow,
} from './rssNormalize';

const FIXTURES = resolve(__dirname, '../../fixtures');
const parser = new Parser();

const feed: FeedRow = {
  id: 'feed-1',
  category: 'new_funding',
  source_name: 'Sample Wire',
  feed_url: 'https://example.com/rss',
  region: 'US',
  tier: 'curated',
};

describe('stripHtml', () => {
  it('removes tags and collapses non-breaking spaces', () => {
    expect(stripHtml('<p>Acme&nbsp;Corp <b>closed</b></p>')).toBe('Acme Corp  closed');
  });

  it('returns an empty string for undefined input', () => {
    expect(stripHtml(undefined)).toBe('');
  });

  it('truncates to the requested limit', () => {
    expect(stripHtml('a'.repeat(50), 10)).toHaveLength(10);
  });
});

describe('itemHash', () => {
  it('is stable for the same guid', () => {
    expect(itemHash('urn:sample:1')).toBe(itemHash('urn:sample:1'));
  });

  it('differs for different guids', () => {
    expect(itemHash('a')).not.toBe(itemHash('b'));
  });

  it('produces a 64-char hex digest', () => {
    expect(itemHash('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('entryTimestamp', () => {
  it('prefers isoDate', () => {
    expect(entryTimestamp({ isoDate: '2026-09-02T08:30:00.000Z' })).toBe(
      '2026-09-02T08:30:00.000Z',
    );
  });

  it('falls back to parsing pubDate', () => {
    expect(entryTimestamp({ pubDate: 'Tue, 02 Sep 2026 08:30:00 GMT' })).toBe(
      '2026-09-02T08:30:00.000Z',
    );
  });

  it('returns null when there is no usable date', () => {
    expect(entryTimestamp({})).toBeNull();
    expect(entryTimestamp({ pubDate: 'not a date' })).toBeNull();
  });
});

describe('normalizeEntries — RSS 2.0', () => {
  it('maps every entry onto the item shape with feed metadata denormalized', async () => {
    const parsed = await parser.parseString(
      readFileSync(resolve(FIXTURES, 'rss-sample-rss2.xml'), 'utf8'),
    );

    const items = normalizeEntries(feed, parsed, MAX_ITEMS_PER_FEED);

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      feed_id: 'feed-1',
      category: 'new_funding',
      source_name: 'Sample Wire',
      region: 'US',
      feed_tier: 'curated',
      title: 'Acme raises $40m Series B',
      link: 'https://example.com/acme-series-b',
      authors: 'Jane Analyst',
      tags: 'funding; venture',
      published_at: '2026-09-02T08:30:00.000Z',
    });
    expect(items[0].summary).toBe('Acme Corp  closed');
  });

  it('hashes the guid when present and the link when it is not', async () => {
    const parsed = await parser.parseString(
      readFileSync(resolve(FIXTURES, 'rss-sample-rss2.xml'), 'utf8'),
    );

    const items = normalizeEntries(feed, parsed, MAX_ITEMS_PER_FEED);

    expect(items[0].item_hash).toBe(itemHash('urn:sample:1'));
    expect(items[1].item_hash).toBe(itemHash('https://example.com/beta-gamma'));
  });

  it('keeps undated entries rather than dropping them', async () => {
    const parsed = await parser.parseString(
      readFileSync(resolve(FIXTURES, 'rss-sample-rss2.xml'), 'utf8'),
    );

    const items = normalizeEntries(feed, parsed, MAX_ITEMS_PER_FEED);

    expect(items[2].title).toBe('Undated note');
    expect(items[2].published_at).toBeNull();
  });

  it('caps the number of entries taken from one feed', async () => {
    const parsed = await parser.parseString(
      readFileSync(resolve(FIXTURES, 'rss-sample-rss2.xml'), 'utf8'),
    );

    expect(normalizeEntries(feed, parsed, 2)).toHaveLength(2);
  });

  it('drops entries with neither guid nor link, since they cannot be deduped', () => {
    const items = normalizeEntries(
      feed,
      { items: [{ title: 'Ghost' }] },
      MAX_ITEMS_PER_FEED,
    );
    expect(items).toEqual([]);
  });

  it('never emits duplicate hashes within a single feed poll', () => {
    const items = normalizeEntries(
      feed,
      {
        items: [
          { title: 'Same', link: 'https://example.com/x' },
          { title: 'Same again', link: 'https://example.com/x' },
        ],
      },
      MAX_ITEMS_PER_FEED,
    );
    expect(items).toHaveLength(1);
  });
});

describe('normalizeEntries — Atom', () => {
  it('reads Atom link/id/updated/author', async () => {
    const parsed = await parser.parseString(
      readFileSync(resolve(FIXTURES, 'rss-sample-atom.xml'), 'utf8'),
    );

    const items = normalizeEntries(
      { ...feed, category: 'industry_reports', source_name: 'Sample Atom Research' },
      parsed,
      MAX_ITEMS_PER_FEED,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: 'Initiating coverage on Delta Industries',
      link: 'https://example.com/delta-initiation',
      published_at: '2026-09-02T06:00:00.000Z',
      category: 'industry_reports',
    });
    expect(items[0].summary).toBe('We initiate at Buy.');
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter data-pipeline test rssNormalize`
Expected: FAIL — cannot resolve `./rssNormalize`.

- [ ] **Step 5: Write the normalizer**

Create `data-pipeline/src/handlers/rssNormalize.ts`:

```ts
/**
 * Pure normalization of parsed RSS/Atom entries into `rss.items` rows.
 *
 * Ported from the Python PoC's `normalize()`. Deliberately free of I/O so the
 * fiddly parts — guid fallbacks, date fallbacks, HTML stripping, in-feed
 * dedupe — are unit-testable against real feed fixtures.
 */
import crypto from 'node:crypto';
import type { RssCategory, RssFeedTier } from '@/lib/db/schema';

/** Entries taken from any single feed per poll. Matches the PoC's default. */
export const MAX_ITEMS_PER_FEED = 25;
export const SUMMARY_LIMIT = 2000;
export const TITLE_LIMIT = 500;
export const TAGS_LIMIT = 500;

const TAG_RE = /<[^>]+>/g;

export interface FeedRow {
  id: string;
  category: RssCategory;
  source_name: string;
  feed_url: string;
  region: string | null;
  tier: RssFeedTier;
}

/** The subset of rss-parser's item shape this module reads. */
export interface RssParserItem {
  title?: string;
  link?: string;
  guid?: string;
  id?: string;
  isoDate?: string;
  pubDate?: string;
  creator?: string;
  author?: string;
  categories?: (string | { _?: string })[];
  contentSnippet?: string;
  content?: string;
  summary?: string;
}

export interface RssParserFeed {
  items?: RssParserItem[];
}

export interface NormalizedItem {
  item_hash: string;
  feed_id: string;
  category: RssCategory;
  source_name: string;
  region: string | null;
  feed_tier: RssFeedTier;
  title: string;
  link: string;
  summary: string | null;
  authors: string | null;
  tags: string | null;
  published_at: string | null;
}

export function stripHtml(text: string | undefined, limit = SUMMARY_LIMIT): string {
  if (!text) return '';
  return text.replace(TAG_RE, ' ').replace(/&nbsp;/g, ' ').replace(/ /g, ' ').trim().slice(0, limit);
}

export function itemHash(guid: string): string {
  return crypto.createHash('sha256').update(guid, 'utf8').digest('hex');
}

/**
 * ISO timestamp for an entry, or null. rss-parser already normalizes most
 * feeds into `isoDate`; `pubDate` is the fallback for feeds it can't.
 * An unparseable date yields null rather than the epoch — a wrong date would
 * silently corrupt the newest-first ordering.
 */
export function entryTimestamp(item: RssParserItem): string | null {
  if (item.isoDate) {
    const iso = new Date(item.isoDate);
    if (!Number.isNaN(iso.getTime())) return iso.toISOString();
  }
  if (item.pubDate) {
    const parsed = new Date(item.pubDate);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

function categoryTerms(item: RssParserItem): string {
  if (!Array.isArray(item.categories)) return '';
  return item.categories
    .map((c) => (typeof c === 'string' ? c : (c?._ ?? '')))
    .map((c) => c.trim())
    .filter(Boolean)
    .join('; ')
    .slice(0, TAGS_LIMIT);
}

export function normalizeEntries(
  feed: FeedRow,
  parsed: RssParserFeed,
  maxItems: number = MAX_ITEMS_PER_FEED,
): NormalizedItem[] {
  const out: NormalizedItem[] = [];
  // A malformed feed can repeat the same guid; the DB would reject the second
  // row of the same INSERT batch, so collapse duplicates here instead.
  const seen = new Set<string>();

  for (const item of (parsed.items ?? []).slice(0, maxItems)) {
    const link = (item.link ?? '').trim();
    const guid = (item.guid ?? item.id ?? link).trim();
    // No stable identity means no dedupe key — skip rather than invent one.
    if (!guid) continue;

    const hash = itemHash(guid);
    if (seen.has(hash)) continue;
    seen.add(hash);

    const summary = stripHtml(item.contentSnippet ?? item.summary ?? item.content);
    const authors = (item.creator ?? item.author ?? '').trim();
    const tags = categoryTerms(item);

    out.push({
      item_hash: hash,
      feed_id: feed.id,
      category: feed.category,
      source_name: feed.source_name,
      region: feed.region,
      feed_tier: feed.tier,
      title: stripHtml(item.title, TITLE_LIMIT),
      link,
      summary: summary.length > 0 ? summary : null,
      authors: authors.length > 0 ? authors : null,
      tags: tags.length > 0 ? tags : null,
      published_at: entryTimestamp(item),
    });
  }

  return out;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter data-pipeline test rssNormalize`
Expected: PASS — 15 tests.

- [ ] **Step 7: Commit**

```bash
git add data-pipeline/src/handlers/rssNormalize.ts data-pipeline/src/handlers/rssNormalize.test.ts \
        data-pipeline/fixtures/rss-sample-rss2.xml data-pipeline/fixtures/rss-sample-atom.xml \
        data-pipeline/package.json pnpm-lock.yaml
git commit -m "feat(rss): add pure RSS entry normalizer with feed fixtures"
```

---

### Task 7: Pipeline `RssRepository`

**Files:**
- Create: `data-pipeline/src/repositories/rssRepository.ts`
- Create: `data-pipeline/src/repositories/rssRepository.test.ts`
- Modify: `data-pipeline/src/repositories/index.ts`

**Interfaces:**
- Consumes: `rssFeeds`, `rssItems`, `rssIngestRuns` tables; `NormalizedItem` from Task 6.
- Produces `class RssRepository { constructor(db: DbClient) }` with:
  - `listActiveFeeds(): Promise<PollableFeed[]>` where `PollableFeed = FeedRow & { etag: string | null; last_modified: string | null }` (exported from this module — `rss-poll` needs the validators alongside the feed metadata)
  - `insertNewItems(items: NormalizedItem[]): Promise<NormalizedItem[]>` — returns only rows that were genuinely new
  - `applyFeedHealth(updates: FeedHealthUpdate[]): Promise<void>`
  - `startRun(kind: 'poll' | 'enrich'): Promise<string>`
  - `finishRun(id: string, stats: Record<string, number>, error?: string | null): Promise<void>`
  - `interface FeedHealthUpdate { id: string; ok: boolean; etag?: string | null; lastModified?: string | null }`
  - `const MAX_CONSECUTIVE_FAILURES = 10`

- [ ] **Step 1: Write the failing test**

Create `data-pipeline/src/repositories/rssRepository.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RssRepository, MAX_CONSECUTIVE_FAILURES } from './rssRepository';
import type { NormalizedItem } from '../handlers/rssNormalize';

// Flatten a drizzle `sql` template back to its text so we can assert on the
// statement without a live database.
function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
  return chunks
    .map((c) => {
      if (typeof c === 'string' || typeof c === 'number') return String(c);
      if (c && typeof c === 'object' && 'value' in (c as object)) {
        const v = (c as { value: unknown }).value;
        return Array.isArray(v) ? v.join('') : String(v);
      }
      return '';
    })
    .join('');
}

const selectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn(),
};
const insertChain = {
  values: vi.fn().mockReturnThis(),
  onConflictDoNothing: vi.fn().mockReturnThis(),
  returning: vi.fn(),
};
const updateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn(),
};

const mockDb = {
  select: vi.fn().mockReturnValue(selectChain),
  insert: vi.fn().mockReturnValue(insertChain),
  update: vi.fn().mockReturnValue(updateChain),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
};

function resetDb() {
  vi.clearAllMocks();
  mockDb.select.mockReturnValue(selectChain);
  mockDb.insert.mockReturnValue(insertChain);
  mockDb.update.mockReturnValue(updateChain);
  mockDb.execute.mockResolvedValue({ rows: [] });
  selectChain.from.mockReturnThis();
  selectChain.where.mockReturnThis();
  insertChain.values.mockReturnThis();
  insertChain.onConflictDoNothing.mockReturnThis();
  updateChain.set.mockReturnThis();
}

function item(hash: string): NormalizedItem {
  return {
    item_hash: hash,
    feed_id: 'feed-1',
    category: 'new_funding',
    source_name: 'Wire',
    region: 'US',
    feed_tier: 'curated',
    title: 'T',
    link: `https://example.com/${hash}`,
    summary: null,
    authors: null,
    tags: null,
    published_at: null,
  };
}

describe('RssRepository.listActiveFeeds', () => {
  beforeEach(resetDb);

  it('selects only active feeds', async () => {
    selectChain.orderBy.mockResolvedValueOnce([{ id: 'feed-1' }]);
    const repo = new RssRepository(mockDb as never);

    const feeds = await repo.listActiveFeeds();

    expect(feeds).toEqual([{ id: 'feed-1' }]);
    expect(selectChain.where).toHaveBeenCalledTimes(1);
  });
});

describe('RssRepository.insertNewItems', () => {
  beforeEach(resetDb);

  it('returns [] without touching the DB for an empty batch', async () => {
    const repo = new RssRepository(mockDb as never);
    expect(await repo.insertNewItems([])).toEqual([]);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('ignores conflicts on item_hash and returns only the genuinely new rows', async () => {
    // Two submitted, one already seen: the DB returns a single hash.
    insertChain.returning.mockResolvedValueOnce([{ item_hash: 'a' }]);
    const repo = new RssRepository(mockDb as never);

    const created = await repo.insertNewItems([item('a'), item('b')]);

    expect(insertChain.onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(created.map((i) => i.item_hash)).toEqual(['a']);
  });

  it('chunks very large batches so the driver parameter limit is never hit', async () => {
    insertChain.returning.mockResolvedValue([]);
    const repo = new RssRepository(mockDb as never);

    await repo.insertNewItems(Array.from({ length: 1200 }, (_, i) => item(`h${i}`)));

    // 1200 rows / 500 per chunk = 3 inserts.
    expect(mockDb.insert).toHaveBeenCalledTimes(3);
  });
});

describe('RssRepository.applyFeedHealth', () => {
  beforeEach(resetDb);

  it('does nothing for an empty update list', async () => {
    const repo = new RssRepository(mockDb as never);
    await repo.applyFeedHealth([]);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('updates every feed in one statement, not one per feed', async () => {
    const repo = new RssRepository(mockDb as never);

    await repo.applyFeedHealth([
      { id: 'f1', ok: true, etag: 'W/"1"', lastModified: null },
      { id: 'f2', ok: false },
    ]);

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain('UPDATE rss.feeds');
    expect(text).toContain('jsonb_to_recordset');
  });

  it('retires a feed once it crosses the consecutive-failure budget', async () => {
    const repo = new RssRepository(mockDb as never);

    await repo.applyFeedHealth([{ id: 'f1', ok: false }]);

    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain(`>= ${MAX_CONSECUTIVE_FAILURES}`);
    expect(text).toContain("'dead'");
  });

  it('keeps the previous etag when the poll produced none (304 or failure)', async () => {
    const repo = new RssRepository(mockDb as never);

    await repo.applyFeedHealth([{ id: 'f1', ok: true }]);

    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain('COALESCE(u.etag, f.etag)');
  });
});

describe('RssRepository run bookkeeping', () => {
  beforeEach(resetDb);

  it('startRun inserts a row and returns its id', async () => {
    insertChain.returning.mockResolvedValueOnce([{ id: 'run-1' }]);
    const repo = new RssRepository(mockDb as never);

    expect(await repo.startRun('poll')).toBe('run-1');
    expect(insertChain.values).toHaveBeenCalledWith({ kind: 'poll' });
  });

  it('finishRun stamps finished_at with the stats payload', async () => {
    updateChain.where.mockResolvedValueOnce(undefined);
    const repo = new RssRepository(mockDb as never);

    await repo.finishRun('run-1', { feeds: 3 });

    const setArg = updateChain.set.mock.calls[0][0];
    expect(setArg.stats).toEqual({ feeds: 3 });
    expect(setArg.error).toBeNull();
    expect(setArg.finished_at).toBeDefined();
  });

  it('finishRun records an error message when one is given', async () => {
    updateChain.where.mockResolvedValueOnce(undefined);
    const repo = new RssRepository(mockDb as never);

    await repo.finishRun('run-1', {}, 'boom');

    expect(updateChain.set.mock.calls[0][0].error).toBe('boom');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter data-pipeline test rssRepository`
Expected: FAIL — cannot resolve `./rssRepository`.

- [ ] **Step 3: Write the repository**

Create `data-pipeline/src/repositories/rssRepository.ts`:

```ts
import { and, asc, eq, sql } from 'drizzle-orm';
import { rssFeeds, rssItems, rssIngestRuns } from '@/lib/db/schema';
import type { DbClient } from '@/lib/repositories';
import type { FeedRow, NormalizedItem } from '../handlers/rssNormalize';

/**
 * Consecutive failed polls before a feed is retired to `dead`. The PoC found
 * ~35% of a raw seed catalog was already rotten, so feeds must retire
 * themselves rather than wait for a human to notice.
 */
export const MAX_CONSECUTIVE_FAILURES = 10;

/** Rows per INSERT statement. 1000+ item batches would blow the pg parameter cap. */
const INSERT_CHUNK = 500;

export interface FeedHealthUpdate {
  id: string;
  ok: boolean;
  /** Fresh validators from a 200. Omitted on 304 or failure — the old ones stand. */
  etag?: string | null;
  lastModified?: string | null;
}

/** A feed plus its stored HTTP validators, which is what the poller needs. */
export type PollableFeed = FeedRow & {
  etag: string | null;
  last_modified: string | null;
};

/** Data access for the ingest Lambdas. Global — the rss schema has no tenant column. */
export class RssRepository {
  constructor(private readonly db: DbClient) {}

  async listActiveFeeds(): Promise<PollableFeed[]> {
    return this.db
      .select({
        id: rssFeeds.id,
        category: rssFeeds.category,
        source_name: rssFeeds.source_name,
        feed_url: rssFeeds.feed_url,
        region: rssFeeds.region,
        tier: rssFeeds.tier,
        etag: rssFeeds.etag,
        last_modified: rssFeeds.last_modified,
      })
      .from(rssFeeds)
      .where(eq(rssFeeds.status, 'active'))
      .orderBy(asc(rssFeeds.category), asc(rssFeeds.source_name)) as Promise<PollableFeed[]>;
  }

  /**
   * Insert a batch, ignoring items already in the lake. The rows the DB
   * actually accepted ARE the genuinely-new set — this replaces the PoC's
   * SQLite "seen ids" ledger with the unique index itself, so it stays correct
   * even with two pollers running at once.
   */
  async insertNewItems(items: NormalizedItem[]): Promise<NormalizedItem[]> {
    if (items.length === 0) return [];

    const byHash = new Map(items.map((i) => [i.item_hash, i]));
    const created: NormalizedItem[] = [];

    for (let offset = 0; offset < items.length; offset += INSERT_CHUNK) {
      const chunk = items.slice(offset, offset + INSERT_CHUNK);
      const inserted = await this.db
        .insert(rssItems)
        .values(chunk)
        .onConflictDoNothing({ target: rssItems.item_hash })
        .returning({ item_hash: rssItems.item_hash });

      for (const row of inserted) {
        const match = byHash.get(row.item_hash);
        if (match) created.push(match);
      }
    }

    return created;
  }

  /**
   * Apply per-feed poll outcomes in ONE statement. A loop of 263 UPDATEs would
   * be a write-side N+1; `jsonb_to_recordset` lets the whole batch travel as a
   * single bound parameter.
   */
  async applyFeedHealth(updates: FeedHealthUpdate[]): Promise<void> {
    if (updates.length === 0) return;

    const payload = JSON.stringify(
      updates.map((u) => ({
        id: u.id,
        ok: u.ok,
        etag: u.etag ?? null,
        last_modified: u.lastModified ?? null,
      })),
    );

    await this.db.execute(sql`
      UPDATE rss.feeds AS f SET
        etag = COALESCE(u.etag, f.etag),
        last_modified = COALESCE(u.last_modified, f.last_modified),
        last_polled_at = now(),
        last_success_at = CASE WHEN u.ok THEN now() ELSE f.last_success_at END,
        consecutive_failures = CASE WHEN u.ok THEN 0 ELSE f.consecutive_failures + 1 END,
        status = CASE
          WHEN NOT u.ok AND f.consecutive_failures + 1 >= ${MAX_CONSECUTIVE_FAILURES}
          THEN 'dead'
          ELSE f.status
        END,
        updated_at = now()
      FROM jsonb_to_recordset(${payload}::jsonb)
        AS u(id uuid, ok boolean, etag text, last_modified text)
      WHERE f.id = u.id
    `);
  }

  async startRun(kind: 'poll' | 'enrich'): Promise<string> {
    const [row] = await this.db
      .insert(rssIngestRuns)
      .values({ kind })
      .returning({ id: rssIngestRuns.id });
    return row.id;
  }

  async finishRun(
    id: string,
    stats: Record<string, number>,
    error: string | null = null,
  ): Promise<void> {
    await this.db
      .update(rssIngestRuns)
      .set({ finished_at: sql`now()`, stats, error })
      .where(eq(rssIngestRuns.id, id));
  }
}
```

Note the unused `and` import will trip lint — remove it if your editor flags it; it is listed only because other repositories in this folder import it.

- [ ] **Step 4: Export from the barrel**

`data-pipeline/src/repositories/index.ts` becomes:

```ts
export * from './martRepository';
export * from './rssRepository';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter data-pipeline test rssRepository`
Expected: PASS — 10 tests.

- [ ] **Step 6: Commit**

```bash
git add data-pipeline/src/repositories/rssRepository.ts \
        data-pipeline/src/repositories/rssRepository.test.ts \
        data-pipeline/src/repositories/index.ts
git commit -m "feat(rss): add pipeline RssRepository with batched feed health updates"
```

---

### Task 8: Feed fetching and S3 bronze archive

**Files:**
- Create: `data-pipeline/src/lib/rssFetch.ts`
- Create: `data-pipeline/src/lib/rssFetch.test.ts`
- Create: `data-pipeline/src/lib/rssBronze.ts`
- Create: `data-pipeline/src/lib/rssBronze.test.ts`

**Interfaces:**
- Consumes: `FeedRow` from Task 6.
- Produces:
  - `fetchFeed(feed: FeedRowWithValidators, deps?: FetchDeps): Promise<FetchOutcome>`
  - `type FetchOutcome = { kind: 'fresh'; xml: string; etag; lastModified } | { kind: 'unchanged' } | { kind: 'failed'; reason: string }`
  - `mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]>`
  - `writeBronze(items: NormalizedItem[], runTimestamp: string, deps?: BronzeDeps): Promise<string[]>` — returns written S3 keys
  - `bronzeKey(category: string, ingestDate: string, runTimestamp: string): string`
  - `const FETCH_TIMEOUT_MS = 20_000`, `const POLL_CONCURRENCY = 12`

- [ ] **Step 1: Write the failing fetch test**

Create `data-pipeline/src/lib/rssFetch.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { fetchFeed, mapWithConcurrency, USER_AGENT } from './rssFetch';

const feed = {
  id: 'f1',
  feed_url: 'https://example.com/rss',
  etag: null as string | null,
  last_modified: null as string | null,
};

function response(init: {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}): Response {
  return {
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    text: async () => init.body ?? '',
    headers: { get: (k: string) => init.headers?.[k.toLowerCase()] ?? null },
  } as unknown as Response;
}

describe('fetchFeed', () => {
  it('returns the body and validators on a 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({
        status: 200,
        body: '<rss/>',
        headers: { etag: 'W/"abc"', 'last-modified': 'Tue, 02 Sep 2026 00:00:00 GMT' },
      }),
    );

    const out = await fetchFeed(feed, { fetchImpl });

    expect(out).toEqual({
      kind: 'fresh',
      xml: '<rss/>',
      etag: 'W/"abc"',
      lastModified: 'Tue, 02 Sep 2026 00:00:00 GMT',
    });
  });

  it('sends the stored validators as conditional request headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ status: 304 }));

    await fetchFeed(
      { ...feed, etag: 'W/"abc"', last_modified: 'Mon, 01 Sep 2026 00:00:00 GMT' },
      { fetchImpl },
    );

    const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('W/"abc"');
    expect(headers['If-Modified-Since']).toBe('Mon, 01 Sep 2026 00:00:00 GMT');
    expect(headers['User-Agent']).toBe(USER_AGENT);
  });

  it('reports 304 as unchanged, which still counts as a healthy poll', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ status: 304 }));
    expect(await fetchFeed(feed, { fetchImpl })).toEqual({ kind: 'unchanged' });
  });

  it('reports an HTTP error as failed with the status in the reason', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ status: 503 }));
    const out = await fetchFeed(feed, { fetchImpl });
    expect(out).toEqual({ kind: 'failed', reason: 'http 503' });
  });

  it('reports a thrown network error as failed rather than propagating it', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const out = await fetchFeed(feed, { fetchImpl });
    expect(out).toEqual({ kind: 'failed', reason: 'ECONNRESET' });
  });

  it('reports an empty 200 body as failed so it is not parsed as a valid feed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ status: 200, body: '   ' }));
    expect(await fetchFeed(feed, { fetchImpl })).toEqual({ kind: 'failed', reason: 'empty body' });
  });
});

describe('mapWithConcurrency', () => {
  it('processes every item and preserves input order in the results', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  it('never runs more than `limit` tasks at once', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('returns [] for an empty input without calling the worker', async () => {
    const fn = vi.fn();
    expect(await mapWithConcurrency([], 4, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter data-pipeline test rssFetch`
Expected: FAIL — cannot resolve `./rssFetch`.

- [ ] **Step 3: Write the fetcher**

Create `data-pipeline/src/lib/rssFetch.ts`:

```ts
/**
 * Polite, conditional feed fetching.
 *
 * Every request carries If-None-Match / If-Modified-Since from the last poll,
 * so an unchanged feed costs a 304 rather than a full download + parse. This
 * is what makes a 30-minute cadence over 263 feeds cheap.
 */
export const FETCH_TIMEOUT_MS = 20_000;
export const POLL_CONCURRENCY = 12;
export const USER_AGENT = 'Mozilla/5.0 (compatible; MnaBrainRSS/1.0; +https://mna-brain.local)';

export interface FeedRowWithValidators {
  id: string;
  feed_url: string;
  etag: string | null;
  last_modified: string | null;
}

export type FetchOutcome =
  | { kind: 'fresh'; xml: string; etag: string | null; lastModified: string | null }
  | { kind: 'unchanged' }
  | { kind: 'failed'; reason: string };

export interface FetchDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function fetchFeed(
  feed: FeedRowWithValidators,
  deps: FetchDeps = {},
): Promise<FetchOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;

  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8' };
  if (feed.etag) headers['If-None-Match'] = feed.etag;
  if (feed.last_modified) headers['If-Modified-Since'] = feed.last_modified;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(feed.feed_url, { headers, signal: controller.signal, redirect: 'follow' });

    if (res.status === 304) return { kind: 'unchanged' };
    if (res.status >= 400) return { kind: 'failed', reason: `http ${res.status}` };

    const xml = await res.text();
    if (xml.trim().length === 0) return { kind: 'failed', reason: 'empty body' };

    return {
      kind: 'fresh',
      xml,
      etag: res.headers.get('ETag'),
      lastModified: res.headers.get('Last-Modified'),
    };
  } catch (err) {
    // A dead feed must never take the whole run down — every failure is data
    // for the health counters instead of an exception.
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: 'failed', reason: reason.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bounded-concurrency map preserving input order. A hand-rolled worker pool
 * rather than p-limit: one fewer runtime dependency to bundle into a Lambda.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}
```

- [ ] **Step 4: Run the fetch tests**

Run: `pnpm --filter data-pipeline test rssFetch`
Expected: PASS — 9 tests.

- [ ] **Step 5: Write the failing bronze test**

Create `data-pipeline/src/lib/rssBronze.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { writeBronze, bronzeKey } from './rssBronze';
import type { NormalizedItem } from '../handlers/rssNormalize';

function item(hash: string, category: NormalizedItem['category']): NormalizedItem {
  return {
    item_hash: hash,
    feed_id: 'f1',
    category,
    source_name: 'Wire',
    region: 'US',
    feed_tier: 'curated',
    title: 'T',
    link: 'https://example.com/x',
    summary: null,
    authors: null,
    tags: null,
    published_at: null,
  };
}

describe('bronzeKey', () => {
  it('uses hive-style category and ingest_date partitions', () => {
    expect(bronzeKey('new_funding', '2026-09-02', '20260902T0830Z')).toBe(
      'bronze/category=new_funding/ingest_date=2026-09-02/run_20260902T0830Z.ndjson',
    );
  });
});

describe('writeBronze', () => {
  it('writes one NDJSON object per category partition', async () => {
    const send = vi.fn().mockResolvedValue({});
    const keys = await writeBronze(
      [item('a', 'new_funding'), item('b', 'ma_partnerships'), item('c', 'new_funding')],
      '20260902T0830Z',
      { send, bucket: 'rss-lake', now: new Date('2026-09-02T08:30:00Z') },
    );

    expect(keys).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('serialises each item as its own NDJSON line', async () => {
    const send = vi.fn().mockResolvedValue({});
    await writeBronze([item('a', 'new_funding'), item('c', 'new_funding')], '20260902T0830Z', {
      send,
      bucket: 'rss-lake',
      now: new Date('2026-09-02T08:30:00Z'),
    });

    const body = send.mock.calls[0][0].input.Body as string;
    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).item_hash).toBe('a');
  });

  it('writes nothing when there are no new items', async () => {
    const send = vi.fn();
    expect(
      await writeBronze([], '20260902T0830Z', { send, bucket: 'rss-lake', now: new Date() }),
    ).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('skips the archive entirely when no bucket is configured', async () => {
    const send = vi.fn();
    const keys = await writeBronze([item('a', 'new_funding')], '20260902T0830Z', {
      send,
      bucket: undefined,
      now: new Date(),
    });
    expect(keys).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('surfaces an S3 failure rather than silently losing the archive', async () => {
    const send = vi.fn().mockRejectedValue(new Error('AccessDenied'));
    await expect(
      writeBronze([item('a', 'new_funding')], '20260902T0830Z', {
        send,
        bucket: 'rss-lake',
        now: new Date(),
      }),
    ).rejects.toThrow('AccessDenied');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter data-pipeline test rssBronze`
Expected: FAIL — cannot resolve `./rssBronze`.

- [ ] **Step 7: Write the bronze archiver**

Create `data-pipeline/src/lib/rssBronze.ts`:

```ts
/**
 * Bronze layer: the immutable raw archive of everything the poller accepted.
 *
 * Postgres is the serving store; this is the replay log. If extraction or
 * classification improves later we can re-derive from bronze instead of
 * re-polling feeds that no longer carry old entries.
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { NormalizedItem } from '../handlers/rssNormalize';

export interface BronzeDeps {
  /** Injected for tests; defaults to a real S3 client in the configured region. */
  send?: (command: PutObjectCommand) => Promise<unknown>;
  bucket?: string;
  now?: Date;
}

let cachedClient: S3Client | null = null;

function defaultSend(command: PutObjectCommand): Promise<unknown> {
  cachedClient ??= new S3Client({ region: process.env.AWS_REGION ?? 'ap-southeast-3' });
  return cachedClient.send(command);
}

export function bronzeKey(category: string, ingestDate: string, runTimestamp: string): string {
  return `bronze/category=${category}/ingest_date=${ingestDate}/run_${runTimestamp}.ndjson`;
}

export async function writeBronze(
  items: NormalizedItem[],
  runTimestamp: string,
  deps: BronzeDeps = {},
): Promise<string[]> {
  const bucket = deps.bucket ?? process.env.RSS_BRONZE_BUCKET;
  // No bucket configured (local dev / SAM) — the DB is still the source of
  // truth, so skip the archive instead of failing the run.
  if (!bucket || items.length === 0) return [];

  const send = deps.send ?? defaultSend;
  const ingestDate = (deps.now ?? new Date()).toISOString().slice(0, 10);

  const byCategory = new Map<string, NormalizedItem[]>();
  for (const item of items) {
    const bucketed = byCategory.get(item.category);
    if (bucketed) bucketed.push(item);
    else byCategory.set(item.category, [item]);
  }

  const keys: string[] = [];
  for (const [category, categoryItems] of byCategory) {
    const key = bronzeKey(category, ingestDate, runTimestamp);
    const body = categoryItems.map((i) => JSON.stringify(i)).join('\n') + '\n';
    await send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'application/x-ndjson',
      }),
    );
    keys.push(key);
  }

  return keys;
}
```

- [ ] **Step 8: Run the bronze tests**

Run: `pnpm --filter data-pipeline test rssBronze`
Expected: PASS — 6 tests.

- [ ] **Step 9: Commit**

```bash
git add data-pipeline/src/lib/rssFetch.ts data-pipeline/src/lib/rssFetch.test.ts \
        data-pipeline/src/lib/rssBronze.ts data-pipeline/src/lib/rssBronze.test.ts
git commit -m "feat(rss): add conditional feed fetching and S3 bronze archive writer"
```

---

### Task 9: `rss-poll` Lambda

**Files:**
- Create: `data-pipeline/src/lambda/rssPoll.ts`
- Create: `data-pipeline/src/lambda/rssPoll.test.ts`
- Modify: `data-pipeline/scripts/build.ts`
- Modify: `data-pipeline/template.yaml`

**Interfaces:**
- Consumes: `RssRepository` (Task 7), `fetchFeed`/`mapWithConcurrency` (Task 8), `writeBronze` (Task 8), `normalizeEntries` (Task 6).
- Produces: `export const handler` returning `{ ok: boolean; result: RssPollResult }` where `RssPollResult = { run_id, feeds_polled, unchanged, failed, items_parsed, items_new, bronze_keys }`.

- [ ] **Step 1: Write the failing test**

Create `data-pipeline/src/lambda/rssPoll.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadSecretsFromSsm: vi.fn().mockResolvedValue(undefined),
  createLambdaDb: vi.fn(),
  pgClientEnd: vi.fn().mockResolvedValue(undefined),
  listActiveFeeds: vi.fn(),
  insertNewItems: vi.fn(),
  applyFeedHealth: vi.fn().mockResolvedValue(undefined),
  startRun: vi.fn().mockResolvedValue('run-1'),
  finishRun: vi.fn().mockResolvedValue(undefined),
  fetchFeed: vi.fn(),
  writeBronze: vi.fn().mockResolvedValue([]),
}));

vi.mock('../secrets', () => ({ loadSecretsFromSsm: mocks.loadSecretsFromSsm }));
vi.mock('../db', () => ({ createLambdaDb: mocks.createLambdaDb }));
vi.mock('../repositories', () => ({
  RssRepository: class {
    listActiveFeeds = mocks.listActiveFeeds;
    insertNewItems = mocks.insertNewItems;
    applyFeedHealth = mocks.applyFeedHealth;
    startRun = mocks.startRun;
    finishRun = mocks.finishRun;
  },
}));
vi.mock('../lib/rssFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/rssFetch')>();
  return { ...actual, fetchFeed: mocks.fetchFeed };
});
vi.mock('../lib/rssBronze', () => ({ writeBronze: mocks.writeBronze }));

import { handler } from './rssPoll';

const RSS_XML = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>Acme raises</title><link>https://example.com/a</link><guid>g-a</guid></item>
  <item><title>Beta merges</title><link>https://example.com/b</link><guid>g-b</guid></item>
</channel></rss>`;

function feed(id: string) {
  return {
    id,
    category: 'new_funding',
    source_name: `Source ${id}`,
    feed_url: `https://example.com/${id}/rss`,
    region: 'US',
    tier: 'curated',
    etag: null,
    last_modified: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createLambdaDb.mockResolvedValue({ pgClient: { end: mocks.pgClientEnd }, db: {} });
  mocks.startRun.mockResolvedValue('run-1');
  mocks.writeBronze.mockResolvedValue([]);
  mocks.insertNewItems.mockImplementation(async (items: unknown[]) => items);
});

describe('rss-poll handler', () => {
  it('parses fresh feeds and reports the new items', async () => {
    mocks.listActiveFeeds.mockResolvedValue([feed('f1')]);
    mocks.fetchFeed.mockResolvedValue({
      kind: 'fresh',
      xml: RSS_XML,
      etag: 'W/"1"',
      lastModified: null,
    });

    const out = await handler({}, {});

    expect(out.ok).toBe(true);
    expect(out.result.feeds_polled).toBe(1);
    expect(out.result.items_parsed).toBe(2);
    expect(out.result.items_new).toBe(2);
  });

  it('counts a 304 as unchanged and healthy, without parsing', async () => {
    mocks.listActiveFeeds.mockResolvedValue([feed('f1')]);
    mocks.fetchFeed.mockResolvedValue({ kind: 'unchanged' });

    const out = await handler({}, {});

    expect(out.result.unchanged).toBe(1);
    expect(out.result.items_parsed).toBe(0);
    expect(mocks.applyFeedHealth).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'f1', ok: true }),
    ]);
  });

  it('marks a fetch failure unhealthy without aborting the run', async () => {
    mocks.listActiveFeeds.mockResolvedValue([feed('f1'), feed('f2')]);
    mocks.fetchFeed
      .mockResolvedValueOnce({ kind: 'failed', reason: 'http 503' })
      .mockResolvedValueOnce({ kind: 'fresh', xml: RSS_XML, etag: null, lastModified: null });

    const out = await handler({}, {});

    expect(out.ok).toBe(true);
    expect(out.result.failed).toBe(1);
    expect(out.result.items_new).toBe(2);
    const health = mocks.applyFeedHealth.mock.calls[0][0];
    expect(health).toContainEqual(expect.objectContaining({ id: 'f1', ok: false }));
    expect(health).toContainEqual(expect.objectContaining({ id: 'f2', ok: true }));
  });

  it('treats unparseable XML as a feed failure, not a crash', async () => {
    mocks.listActiveFeeds.mockResolvedValue([feed('f1')]);
    mocks.fetchFeed.mockResolvedValue({
      kind: 'fresh',
      xml: 'not xml at all',
      etag: null,
      lastModified: null,
    });

    const out = await handler({}, {});

    expect(out.ok).toBe(true);
    expect(out.result.failed).toBe(1);
    expect(mocks.applyFeedHealth.mock.calls[0][0][0]).toMatchObject({ id: 'f1', ok: false });
  });

  it('archives new items to bronze before returning', async () => {
    mocks.listActiveFeeds.mockResolvedValue([feed('f1')]);
    mocks.fetchFeed.mockResolvedValue({ kind: 'fresh', xml: RSS_XML, etag: null, lastModified: null });
    mocks.writeBronze.mockResolvedValue(['bronze/category=new_funding/ingest_date=x/run_y.ndjson']);

    const out = await handler({}, {});

    expect(mocks.writeBronze).toHaveBeenCalledTimes(1);
    expect(mocks.writeBronze.mock.calls[0][0]).toHaveLength(2);
    expect(out.result.bronze_keys).toHaveLength(1);
  });

  it('only archives genuinely new items, not everything parsed', async () => {
    mocks.listActiveFeeds.mockResolvedValue([feed('f1')]);
    mocks.fetchFeed.mockResolvedValue({ kind: 'fresh', xml: RSS_XML, etag: null, lastModified: null });
    // The DB says only the first hash was new.
    mocks.insertNewItems.mockImplementation(async (items: { item_hash: string }[]) => [items[0]]);

    const out = await handler({}, {});

    expect(out.result.items_parsed).toBe(2);
    expect(out.result.items_new).toBe(1);
    expect(mocks.writeBronze.mock.calls[0][0]).toHaveLength(1);
  });

  it('records the run and always closes the pg client', async () => {
    mocks.listActiveFeeds.mockResolvedValue([]);

    await handler({}, {});

    expect(mocks.startRun).toHaveBeenCalledWith('poll');
    expect(mocks.finishRun).toHaveBeenCalledWith('run-1', expect.any(Object), null);
    expect(mocks.pgClientEnd).toHaveBeenCalledTimes(1);
  });

  it('records the error on the run row and rethrows when the poll blows up', async () => {
    mocks.listActiveFeeds.mockRejectedValue(new Error('db down'));

    await expect(handler({}, {})).rejects.toThrow('db down');

    expect(mocks.finishRun).toHaveBeenCalledWith('run-1', expect.any(Object), 'db down');
    expect(mocks.pgClientEnd).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter data-pipeline test rssPoll`
Expected: FAIL — cannot resolve `./rssPoll`.

- [ ] **Step 3: Write the Lambda**

Create `data-pipeline/src/lambda/rssPoll.ts`:

```ts
/**
 * rss-poll — scheduled every 30 minutes.
 *
 * Conditional-GETs every active feed, normalizes entries, inserts the
 * genuinely-new ones into rss.items, archives them to S3 bronze, and records
 * per-feed health. Deliberately does NO enrichment: classification, article
 * fetching and embedding all run in rss-enrich so a slow scrape or a flaky LLM
 * can never delay the next poll.
 *
 * Idempotent: 304s skip unchanged feeds, and the unique index on item_hash
 * makes re-inserting a seen item a no-op.
 */
import Parser from 'rss-parser';
import { loadSecretsFromSsm } from '../secrets';
import { createLambdaDb } from '../db';
import { RssRepository, type FeedHealthUpdate } from '../repositories';
import { fetchFeed, mapWithConcurrency, POLL_CONCURRENCY } from '../lib/rssFetch';
import { writeBronze } from '../lib/rssBronze';
import {
  normalizeEntries,
  MAX_ITEMS_PER_FEED,
  type NormalizedItem,
} from '../handlers/rssNormalize';
import { pipelineLog, pipelineError } from '../lib/pipelineLog';

const SCOPE = 'rss-poll';

export interface RssPollResult {
  run_id: string;
  feeds_polled: number;
  unchanged: number;
  failed: number;
  items_parsed: number;
  items_new: number;
  bronze_keys: string[];
}

export const handler = async (
  _event: unknown,
  _ctx: unknown,
): Promise<{ ok: boolean; result: RssPollResult }> => {
  await loadSecretsFromSsm();
  const { pgClient, db } = await createLambdaDb();
  const repo = new RssRepository(db);
  const runId = await repo.startRun('poll');
  const runTimestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

  const result: RssPollResult = {
    run_id: runId,
    feeds_polled: 0,
    unchanged: 0,
    failed: 0,
    items_parsed: 0,
    items_new: 0,
    bronze_keys: [],
  };

  try {
    const feeds = await repo.listActiveFeeds();
    result.feeds_polled = feeds.length;
    pipelineLog(SCOPE, 'polling', { run_id: runId, feeds: feeds.length });

    const parser = new Parser();
    const health: FeedHealthUpdate[] = [];
    const parsedItems: NormalizedItem[] = [];

    const outcomes = await mapWithConcurrency(feeds, POLL_CONCURRENCY, async (feed) => {
      const fetched = await fetchFeed(feed);
      if (fetched.kind !== 'fresh') return { feed, fetched, items: [] as NormalizedItem[] };

      try {
        const parsed = await parser.parseString(fetched.xml);
        return {
          feed,
          fetched,
          items: normalizeEntries(feed, parsed, MAX_ITEMS_PER_FEED),
        };
      } catch (err) {
        // Malformed XML is a feed problem, not a run problem — convert it into
        // a health signal so the feed eventually retires itself.
        const reason = err instanceof Error ? err.message : String(err);
        return {
          feed,
          fetched: { kind: 'failed' as const, reason: `parse: ${reason.slice(0, 120)}` },
          items: [] as NormalizedItem[],
        };
      }
    });

    for (const { feed, fetched, items } of outcomes) {
      if (fetched.kind === 'unchanged') {
        result.unchanged++;
        health.push({ id: feed.id, ok: true });
        continue;
      }
      if (fetched.kind === 'failed') {
        result.failed++;
        health.push({ id: feed.id, ok: false });
        continue;
      }
      health.push({
        id: feed.id,
        ok: true,
        etag: fetched.etag,
        lastModified: fetched.lastModified,
      });
      parsedItems.push(...items);
    }

    result.items_parsed = parsedItems.length;

    const created = await repo.insertNewItems(parsedItems);
    result.items_new = created.length;

    // Bronze mirrors what actually entered the lake, so re-runs don't append
    // duplicate archive lines.
    result.bronze_keys = await writeBronze(created, runTimestamp);

    await repo.applyFeedHealth(health);
    await repo.finishRun(runId, toStats(result), null);

    pipelineLog(SCOPE, 'done', {
      run_id: runId,
      feeds: result.feeds_polled,
      unchanged: result.unchanged,
      failed: result.failed,
      items_new: result.items_new,
    });
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await repo.finishRun(runId, toStats(result), message).catch(() => undefined);
    pipelineError(SCOPE, 'failed', err, { run_id: runId });
    throw err;
  } finally {
    await pgClient.end();
  }
};

function toStats(result: RssPollResult): Record<string, number> {
  return {
    feeds_polled: result.feeds_polled,
    unchanged: result.unchanged,
    failed: result.failed,
    items_parsed: result.items_parsed,
    items_new: result.items_new,
    bronze_objects: result.bronze_keys.length,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter data-pipeline test rssPoll`
Expected: PASS — 8 tests.

- [ ] **Step 5: Register the Lambda in the bundler**

In `data-pipeline/scripts/build.ts`, extend the `ENTRIES` map:

```ts
const ENTRIES: Record<string, string> = {
  vaultArchiveStart: 'vault-archive-start',
  vaultArchivePoll: 'vault-archive-poll',
  rssPoll: 'rss-poll',
};
```

- [ ] **Step 6: Add the SAM resource for local invocation**

Append to the `Resources:` block of `data-pipeline/template.yaml`:

```yaml
  RssPoll:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: rss-poll
      CodeUri: dist/rss-poll/
      Handler: index.handler
```

- [ ] **Step 7: Verify it builds and typechecks**

Run: `pnpm --filter data-pipeline tsc && pnpm --filter data-pipeline build`
Expected: tsc clean; build prints `✓ rssPoll → dist/rss-poll/index.js + dist/rss-poll.zip`.

- [ ] **Step 8: Smoke-test against local Postgres**

With local Postgres seeded (Task 5) and `.env.local` populated:

```bash
pnpm --filter data-pipeline invoke rssPoll '{}'
```

Expected: JSON result with `feeds_polled` ≥ 15 and a non-zero `items_new` on the first run (the seeded feeds are real URLs, so this makes real network calls). Run it a second time — `items_new` should drop sharply and `unchanged` should rise, proving conditional GET and hash dedupe both work.

If `invoke` does not accept a camelCase name, check `data-pipeline/scripts/invoke-local.ts` for the naming it expects and use that.

- [ ] **Step 9: Commit**

```bash
git add data-pipeline/src/lambda/rssPoll.ts data-pipeline/src/lambda/rssPoll.test.ts \
        data-pipeline/scripts/build.ts data-pipeline/template.yaml
git commit -m "feat(rss): add rss-poll lambda with bronze archiving and feed health"
```

---

### Task 10: Infrastructure for the poll Lambda

**Files:**
- Create: `terraform/s3-rss/main.tf`, `variables.tf`, `outputs.tf`, `versions.tf`, `Makefile`
- Modify: `data-pipeline/terraform/pipeline-compute/main.tf`
- Modify: `data-pipeline/terraform/pipeline-compute/data.tf`
- Modify: `data-pipeline/terraform/pipeline-compute/iam.tf`

**Interfaces:**
- Consumes: the `rss-poll` bundle produced by Task 9's build.
- Produces: bucket `mna-<env>-rss-lake`; remote-state output `bucket_arn` / `bucket_id`; Lambda env var `RSS_BRONZE_BUCKET`; an EventBridge schedule for `rss-poll`.

- [ ] **Step 1: Create the RSS bucket module**

Create `terraform/s3-rss/versions.tf`:

```hcl
terraform {
  required_version = ">= 1.3"

  backend "s3" {
    key    = "mna/s3-rss"
    region = "ap-southeast-3"
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.3.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
```

Create `terraform/s3-rss/variables.tf`:

```hcl
variable "aws_region" {
  description = "AWS region for the RSS lake bucket."
  type        = string
  default     = "ap-southeast-3"
}

locals {
  workspace_config = {
    staging = {
      environment = "staging"
    }
    production = {
      environment = "production"
    }
  }

  current_config = local.workspace_config[terraform.workspace]
  environment    = local.current_config.environment
  bucket_name    = "mna-${local.environment}-rss-lake"

  common_tags = {
    Project     = "mna"
    Environment = local.environment
    ManagedBy   = "terraform"
    Component   = "rss-lake"
  }
}
```

Create `terraform/s3-rss/main.tf`:

```hcl
# Bronze archive for the Data Navigator RSS lake.
#
# Deliberately separate from the app-data bucket and from the email pipeline
# (which has no S3 access at all, by design). Contents are machine-written
# NDJSON, replayable, and never served to browsers — hence no CORS and no
# versioning (the objects are already immutable, one per run).
resource "aws_s3_bucket" "rss_lake" {
  bucket = local.bucket_name

  tags = merge(local.common_tags, {
    Name = local.bucket_name
  })
}

resource "aws_s3_bucket_server_side_encryption_configuration" "rss_lake" {
  bucket = aws_s3_bucket.rss_lake.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "rss_lake" {
  bucket = aws_s3_bucket.rss_lake.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Bronze is the replay log — retained indefinitely per the approved design.
# Abort dangling multipart uploads so they can't accumulate storage cost.
resource "aws_s3_bucket_lifecycle_configuration" "rss_lake" {
  bucket = aws_s3_bucket.rss_lake.id

  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}
```

Create `terraform/s3-rss/outputs.tf`:

```hcl
output "bucket_id" {
  description = "Name of the RSS lake bucket."
  value       = aws_s3_bucket.rss_lake.id
}

output "bucket_arn" {
  description = "ARN of the RSS lake bucket."
  value       = aws_s3_bucket.rss_lake.arn
}
```

Create `terraform/s3-rss/Makefile` by copying the pattern from an existing module:

```bash
cp terraform/s3/Makefile terraform/s3-rss/Makefile
```

Then open it and confirm it has `init-staging` and `init-production` targets and that any module-name references point at `s3-rss`. Every module in this repo must have both targets.

- [ ] **Step 2: Wire the bucket into pipeline-compute's remote state**

Append to `data-pipeline/terraform/pipeline-compute/data.tf`:

```hcl
# RSS bronze bucket — created by terraform/s3-rss, consumed here for the
# Lambda env var and the S3 write policy.
data "terraform_remote_state" "s3_rss" {
  backend = "s3"

  config = {
    bucket = local.tfstate_bucket
    key    = "env:/${terraform.workspace}/mna/s3-rss"
    region = var.aws_region
  }
}
```

Verify the `key` format matches the existing remote-state blocks in that file — copy their exact `env:/…` prefix convention rather than trusting this snippet, since a wrong key silently yields an empty state.

- [ ] **Step 3: Grant the Lambda role S3 write on the bronze prefix**

Append to `data-pipeline/terraform/pipeline-compute/iam.tf`:

```hcl
# S3 — the RSS Lambdas write the bronze archive. Scoped to the bronze prefix
# of the RSS lake bucket only; the email Lambdas share this role but never
# call S3, so the no-S3 email guarantee is a code property, not an IAM one.
resource "aws_iam_policy" "rss_bronze_write" {
  name        = "${local.prefix}-rss-bronze-write"
  description = "Allow pipeline Lambdas to write the RSS bronze archive"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "PutBronzeObjects"
      Effect   = "Allow"
      Action   = ["s3:PutObject"]
      Resource = "${data.terraform_remote_state.s3_rss.outputs.bucket_arn}/bronze/*"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "rss_bronze_write" {
  role       = aws_iam_role.pipeline_lambda.name
  policy_arn = aws_iam_policy.rss_bronze_write.arn
}
```

- [ ] **Step 4: Add the schedule and env var**

In `data-pipeline/terraform/pipeline-compute/main.tf`, add to the `lambda_configs` map (inside `locals`, after the `vault-archive-poll` entry):

```hcl
    rss-poll = {
      handler      = "rssPoll.handler"
      schedule     = "rate(30 minutes)"
      description  = "Conditional-GET every active RSS feed; upsert new items and archive them to S3 bronze"
      memory_heavy = false
      input        = jsonencode({})
    }
```

and add to the `lambda_env` map:

```hcl
    RSS_BRONZE_BUCKET = data.terraform_remote_state.s3_rss.outputs.bucket_id
```

- [ ] **Step 5: Validate the Terraform**

```bash
cd terraform/s3-rss && terraform fmt -check && terraform init -backend=false && terraform validate && cd -
cd data-pipeline/terraform/pipeline-compute && terraform fmt -check && terraform validate && cd -
```

Expected: both `validate` calls print `Success! The configuration is valid.`

If `pipeline-compute` validate fails on the new remote state, it is because `terraform init` has not run since `data.tf` changed — run `make init-staging` in that directory first.

- [ ] **Step 6: Commit**

```bash
git add terraform/s3-rss data-pipeline/terraform/pipeline-compute
git commit -m "feat(rss): provision rss lake bucket and schedule the rss-poll lambda"
```

- [ ] **Step 7: Deploy to staging (manual, requires AWS credentials)**

```bash
pnpm --filter data-pipeline build
cd terraform/s3-rss && make init-staging && terraform apply && cd -
cd data-pipeline/terraform/pipeline-compute && make init-staging && terraform apply && cd -
```

Then seed the staging catalog and trigger one run:

```bash
pnpm rss:import-feeds --base https://<staging-host>
aws lambda invoke --function-name mna-staging-pipeline-rss-poll --payload '{}' /tmp/rss-poll.json
cat /tmp/rss-poll.json
```

Expected: `ok: true`, `feeds_polled` ≈ 263, `items_new` in the low thousands on the first run. Confirm bronze objects landed:

```bash
aws s3 ls s3://mna-staging-rss-lake/bronze/ --recursive | head
```

**Note:** a brand-new Lambda must be created by `terraform apply` before GitHub Actions can deploy code updates to it — the CI deploy policy is scoped to the existing function ARNs.

---

**Phase 2 exit criteria:** `rss-poll` runs on a 30-minute schedule in staging, populating `rss.items` and `s3://mna-staging-rss-lake/bronze/`; a second run is nearly a no-op; dead feeds accumulate `consecutive_failures` and retire at 10; `rss.ingest_runs` has one row per run.

---

# Phase 3 — Enrichment pipeline

### Task 11: Relevance classifier

**Files:**
- Create: `data-pipeline/src/handlers/rssClassify.ts`
- Create: `data-pipeline/src/handlers/rssClassify.test.ts`

**Interfaces:**
- Consumes: `RssCategory`, `RssFeedTier`.
- Produces:
  - `buildClassifyPrompt(items: ClassifiableItem[]): string`
  - `parseClassifyResponse(text: string, batchSize: number): ClassificationVerdict[]`
  - `applyTierThreshold(verdict, tier): boolean`
  - `decideSelections(verdicts, items, remainingByCategory): SelectionDecision[]`
  - `classifyBatch(items, deps): Promise<ClassificationVerdict[]>`
  - `interface ClassifiableItem { id; category; source_name; feed_tier; title; summary }`
  - `interface ClassificationVerdict { index; relevant; score; companies; topics; reason }`
  - `interface SelectionDecision { id; relevance: 'selected' | 'rejected'; score; labels }`
  - `const CURATED_THRESHOLD = 0.5`, `const QUERY_THRESHOLD = 0.7`, `const CLASSIFY_BATCH_SIZE = 20`, `const CLASSIFY_MODEL = 'claude-haiku-4-5-20251001'`

- [ ] **Step 1: Write the failing test**

Create `data-pipeline/src/handlers/rssClassify.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  buildClassifyPrompt,
  parseClassifyResponse,
  applyTierThreshold,
  decideSelections,
  classifyBatch,
  CURATED_THRESHOLD,
  QUERY_THRESHOLD,
  type ClassifiableItem,
} from './rssClassify';

function item(overrides: Partial<ClassifiableItem> = {}): ClassifiableItem {
  return {
    id: 'i1',
    category: 'new_funding',
    source_name: 'DealStreetAsia',
    feed_tier: 'curated',
    title: 'Acme raises $40m Series B',
    summary: 'Acme Corp closed a round led by Beta Ventures.',
    ...overrides,
  };
}

describe('buildClassifyPrompt', () => {
  it('numbers each item so the model can key its answers by index', () => {
    const prompt = buildClassifyPrompt([item(), item({ id: 'i2', title: 'Second' })]);
    expect(prompt).toContain('[0]');
    expect(prompt).toContain('[1]');
  });

  it('tells the model which category rubric applies to each item', () => {
    expect(buildClassifyPrompt([item()])).toContain('new_funding');
  });

  it('flags query-tier items so the model knows they are keyword-search noise', () => {
    const prompt = buildClassifyPrompt([item({ feed_tier: 'query' })]);
    expect(prompt.toLowerCase()).toContain('keyword search');
  });
});

describe('parseClassifyResponse', () => {
  it('parses a clean JSON array', () => {
    const out = parseClassifyResponse(
      '[{"index":0,"relevant":true,"score":0.9,"companies":["Acme"],"topics":["funding"],"reason":"Series B"}]',
      1,
    );
    expect(out).toEqual([
      { index: 0, relevant: true, score: 0.9, companies: ['Acme'], topics: ['funding'], reason: 'Series B' },
    ]);
  });

  it('tolerates markdown code fences around the JSON', () => {
    const out = parseClassifyResponse(
      '```json\n[{"index":0,"relevant":false,"score":0.1}]\n```',
      1,
    );
    expect(out[0].relevant).toBe(false);
  });

  it('clamps scores into 0..1', () => {
    const out = parseClassifyResponse('[{"index":0,"relevant":true,"score":9}]', 1);
    expect(out[0].score).toBe(1);
  });

  it('drops verdicts whose index is outside the batch', () => {
    const out = parseClassifyResponse('[{"index":7,"relevant":true,"score":1}]', 1);
    expect(out).toEqual([]);
  });

  it('defaults missing label arrays to empty rather than undefined', () => {
    const out = parseClassifyResponse('[{"index":0,"relevant":true,"score":0.8}]', 1);
    expect(out[0].companies).toEqual([]);
    expect(out[0].topics).toEqual([]);
  });

  it('returns [] for unparseable output instead of throwing', () => {
    expect(parseClassifyResponse('I cannot help with that.', 3)).toEqual([]);
  });
});

describe('applyTierThreshold', () => {
  it('accepts a curated item at the lower bar', () => {
    expect(applyTierThreshold({ relevant: true, score: CURATED_THRESHOLD }, 'curated')).toBe(true);
  });

  it('holds a query-tier item to a higher bar', () => {
    expect(applyTierThreshold({ relevant: true, score: CURATED_THRESHOLD }, 'query')).toBe(false);
    expect(applyTierThreshold({ relevant: true, score: QUERY_THRESHOLD }, 'query')).toBe(true);
  });

  it('rejects anything the model called irrelevant regardless of score', () => {
    expect(applyTierThreshold({ relevant: false, score: 0.99 }, 'curated')).toBe(false);
  });
});

describe('decideSelections', () => {
  it('selects items that clear the threshold while capacity remains', () => {
    const decisions = decideSelections(
      [{ index: 0, relevant: true, score: 0.9, companies: ['Acme'], topics: ['funding'], reason: 'r' }],
      [item()],
      { new_funding: 5 },
    );
    expect(decisions[0]).toMatchObject({ id: 'i1', relevance: 'selected', score: 0.9 });
    expect(decisions[0].labels).toEqual({ companies: ['Acme'], topics: ['funding'], reason: 'r' });
  });

  it('rejects with reason "cap" once the category budget is spent', () => {
    const items = [item({ id: 'a' }), item({ id: 'b' })];
    const verdicts = items.map((_, index) => ({
      index,
      relevant: true,
      score: 0.95,
      companies: [],
      topics: [],
      reason: 'strong',
    }));

    const decisions = decideSelections(verdicts, items, { new_funding: 1 });

    expect(decisions[0].relevance).toBe('selected');
    expect(decisions[1].relevance).toBe('rejected');
    expect(decisions[1].labels.reason).toBe('cap');
  });

  it('spends each category budget independently', () => {
    const items = [item({ id: 'a' }), item({ id: 'b', category: 'ma_partnerships' })];
    const verdicts = items.map((_, index) => ({
      index, relevant: true, score: 0.95, companies: [], topics: [], reason: 'r',
    }));

    const decisions = decideSelections(verdicts, items, { new_funding: 1, ma_partnerships: 1 });

    expect(decisions.every((d) => d.relevance === 'selected')).toBe(true);
  });

  it('rejects items the model never returned a verdict for, so nothing stays pending forever', () => {
    const decisions = decideSelections([], [item()], { new_funding: 5 });
    expect(decisions[0]).toMatchObject({ relevance: 'rejected', score: 0 });
    expect(decisions[0].labels.reason).toBe('no verdict');
  });

  it('prefers higher-scoring items when the cap cannot fit them all', () => {
    const items = [item({ id: 'low' }), item({ id: 'high' })];
    const verdicts = [
      { index: 0, relevant: true, score: 0.6, companies: [], topics: [], reason: 'r' },
      { index: 1, relevant: true, score: 0.95, companies: [], topics: [], reason: 'r' },
    ];

    const decisions = decideSelections(verdicts, items, { new_funding: 1 });
    const byId = Object.fromEntries(decisions.map((d) => [d.id, d.relevance]));

    expect(byId.high).toBe('selected');
    expect(byId.low).toBe('rejected');
  });
});

describe('classifyBatch', () => {
  it('sends one Anthropic call per batch and returns parsed verdicts', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '[{"index":0,"relevant":true,"score":0.8}]' }],
    });

    const out = await classifyBatch([item()], { client: { messages: { create } } as never });

    expect(create).toHaveBeenCalledTimes(1);
    expect(out[0].score).toBe(0.8);
  });

  it('returns [] when the model call fails, leaving the items for a later run', async () => {
    const create = vi.fn().mockRejectedValue(new Error('rate limited'));
    expect(await classifyBatch([item()], { client: { messages: { create } } as never })).toEqual([]);
  });

  it('does not call the model for an empty batch', async () => {
    const create = vi.fn();
    expect(await classifyBatch([], { client: { messages: { create } } as never })).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter data-pipeline test rssClassify`
Expected: FAIL — cannot resolve `./rssClassify`.

- [ ] **Step 3: Write the classifier**

Create `data-pipeline/src/handlers/rssClassify.ts`:

```ts
/**
 * Relevance classification for freshly-polled items.
 *
 * Raw intake is thousands of items/day; the business target is ~75 useful
 * ones. Haiku scores title+summary, tier-aware thresholds filter, and a
 * per-category daily cap makes the final volume deterministic regardless of
 * how generous the model feels on a given day.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { RssCategory, RssFeedTier, RssItemLabels } from '@/lib/db/schema';

export const CLASSIFY_MODEL = 'claude-haiku-4-5-20251001';
export const CLASSIFY_BATCH_SIZE = 20;
/** Publisher/wire/regulator feeds — trusted, so a moderate score is enough. */
export const CURATED_THRESHOLD = 0.5;
/** Google/Bing keyword feeds — noisy, so they must clear a higher bar. */
export const QUERY_THRESHOLD = 0.7;

const CATEGORY_RUBRIC: Record<RssCategory, string> = {
  expert_insights:
    'Substantive analysis or commentary from a named expert, think tank, central bank or research institution. Not routine news reporting.',
  market_assessment:
    'Market size, market share, segment growth, annual-report figures, company announcements or proxy-meeting outcomes with concrete numbers.',
  new_funding:
    'A company raising capital: seed/Series A-E, growth round, PE investment, IPO proceeds. Must name a company and ideally an amount.',
  ma_partnerships:
    'A merger, acquisition, divestiture, joint venture or strategic partnership between named companies.',
  industry_reports:
    'Sell-side or agency research: initiation of coverage, rating actions, industry outlooks, IGO/regulator research publications.',
};

export interface ClassifiableItem {
  id: string;
  category: RssCategory;
  source_name: string;
  feed_tier: RssFeedTier;
  title: string;
  summary: string | null;
}

export interface ClassificationVerdict {
  index: number;
  relevant: boolean;
  score: number;
  companies: string[];
  topics: string[];
  reason: string;
}

export interface SelectionDecision {
  id: string;
  relevance: 'selected' | 'rejected';
  score: number;
  labels: RssItemLabels;
}

export function buildClassifyPrompt(items: ClassifiableItem[]): string {
  const entries = items
    .map((item, index) => {
      const tierNote =
        item.feed_tier === 'query'
          ? ' (source is an automated keyword search feed — be stricter, these often surface off-topic matches)'
          : '';
      return [
        `[${index}] category: ${item.category}`,
        `    rubric: ${CATEGORY_RUBRIC[item.category]}`,
        `    source: ${item.source_name}${tierNote}`,
        `    title: ${item.title}`,
        `    summary: ${(item.summary ?? '').slice(0, 600)}`,
      ].join('\n');
    })
    .join('\n\n');

  return [
    'You screen financial news for an M&A deal team. For each numbered item decide whether it genuinely satisfies its category rubric.',
    '',
    entries,
    '',
    'Reply with ONLY a JSON array, one object per item, no prose and no code fence:',
    '[{"index":0,"relevant":true,"score":0.0-1.0,"companies":["Name"],"topics":["short tag"],"reason":"under 15 words"}]',
    '',
    'score is your confidence that the item is genuinely useful to the deal team. Be strict: routine coverage, opinion pieces without data, and off-topic matches score below 0.4.',
  ].join('\n');
}

export function parseClassifyResponse(
  text: string,
  batchSize: number,
): ClassificationVerdict[] {
  // Models sometimes wrap JSON in a fence despite instructions; slice to the
  // outermost array rather than failing the whole batch over formatting.
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ClassificationVerdict[] = [];
  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const index = Number(row.index);
    if (!Number.isInteger(index) || index < 0 || index >= batchSize) continue;

    out.push({
      index,
      relevant: row.relevant === true,
      score: clamp(Number(row.score)),
      companies: strings(row.companies),
      topics: strings(row.topics),
      reason: typeof row.reason === 'string' ? row.reason.slice(0, 200) : '',
    });
  }
  return out;
}

export function applyTierThreshold(
  verdict: { relevant: boolean; score: number },
  tier: RssFeedTier,
): boolean {
  if (!verdict.relevant) return false;
  return verdict.score >= (tier === 'query' ? QUERY_THRESHOLD : CURATED_THRESHOLD);
}

/**
 * Turn verdicts into per-item outcomes, spending each category's remaining
 * daily budget on the highest-scoring candidates first. Every input item gets
 * a decision — an item with no verdict is rejected rather than left pending,
 * so the classification queue always drains.
 */
export function decideSelections(
  verdicts: ClassificationVerdict[],
  items: ClassifiableItem[],
  remainingByCategory: Partial<Record<RssCategory, number>>,
): SelectionDecision[] {
  const budget = { ...remainingByCategory };
  const byIndex = new Map(verdicts.map((v) => [v.index, v]));

  const candidates = items
    .map((item, index) => ({ item, index, verdict: byIndex.get(index) }))
    .filter((c) => c.verdict !== undefined && applyTierThreshold(c.verdict, c.item.feed_tier))
    .sort((a, b) => (b.verdict?.score ?? 0) - (a.verdict?.score ?? 0));

  const selected = new Set<number>();
  for (const candidate of candidates) {
    const left = budget[candidate.item.category] ?? 0;
    if (left <= 0) continue;
    budget[candidate.item.category] = left - 1;
    selected.add(candidate.index);
  }

  return items.map((item, index) => {
    const verdict = byIndex.get(index);
    if (!verdict) {
      return {
        id: item.id,
        relevance: 'rejected' as const,
        score: 0,
        labels: { companies: [], topics: [], reason: 'no verdict' },
      };
    }
    const passed = applyTierThreshold(verdict, item.feed_tier);
    const isSelected = selected.has(index);
    return {
      id: item.id,
      relevance: isSelected ? ('selected' as const) : ('rejected' as const),
      score: verdict.score,
      labels: {
        companies: verdict.companies,
        topics: verdict.topics,
        reason: passed && !isSelected ? 'cap' : verdict.reason,
      },
    };
  });
}

export interface ClassifyDeps {
  client?: Pick<Anthropic, 'messages'>;
  model?: string;
}

let cachedClient: Anthropic | null = null;

export async function classifyBatch(
  items: ClassifiableItem[],
  deps: ClassifyDeps = {},
): Promise<ClassificationVerdict[]> {
  if (items.length === 0) return [];
  const client = deps.client ?? (cachedClient ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

  try {
    const response = await client.messages.create({
      model: deps.model ?? CLASSIFY_MODEL,
      max_tokens: 2048,
      messages: [{ role: 'user', content: buildClassifyPrompt(items) }],
    });

    const text = (response.content ?? [])
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return parseClassifyResponse(text, items.length);
  } catch (err) {
    // A model outage must not consume the batch — returning [] leaves every
    // item `pending` so the next run retries it.
    console.error('[rss-enrich] classification call failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').map((v) => v.slice(0, 120));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter data-pipeline test rssClassify`
Expected: PASS — 18 tests.

- [ ] **Step 5: Commit**

```bash
git add data-pipeline/src/handlers/rssClassify.ts data-pipeline/src/handlers/rssClassify.test.ts
git commit -m "feat(rss): add Haiku relevance classifier with tier thresholds and daily caps"
```

---

### Task 12: Article content extraction

**Files:**
- Create: `data-pipeline/src/lib/rssContent.ts`
- Create: `data-pipeline/src/lib/rssContent.test.ts`
- Modify: `data-pipeline/package.json` (add `@extractus/article-extractor`)

**Interfaces:**
- Produces:
  - `fetchArticleContent(url: string, deps?: ContentDeps): Promise<ContentOutcome>`
  - `type ContentOutcome = { kind: 'ok'; text: string } | { kind: 'failed'; reason: string }`
  - `const CONTENT_TIMEOUT_MS = 15_000`, `const CONTENT_MAX_BYTES = 200_000`, `const MAX_CONTENT_ATTEMPTS = 3`

- [ ] **Step 1: Add the extractor dependency**

```bash
pnpm --filter data-pipeline add @extractus/article-extractor
```

Expected: adds `"@extractus/article-extractor": "^9.0.1"`.

- [ ] **Step 2: Write the failing test**

Create `data-pipeline/src/lib/rssContent.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { fetchArticleContent, CONTENT_MAX_BYTES } from './rssContent';

describe('fetchArticleContent', () => {
  it('returns the extracted plain text of the article body', async () => {
    const extract = vi.fn().mockResolvedValue({
      content: '<p>Acme <b>raised</b> $40m in a round led by Beta.</p>',
    });

    const out = await fetchArticleContent('https://example.com/a', { extract });

    expect(out).toEqual({ kind: 'ok', text: 'Acme raised $40m in a round led by Beta.' });
  });

  it('reports a failure when the extractor finds no article', async () => {
    const extract = vi.fn().mockResolvedValue(null);
    expect(await fetchArticleContent('https://example.com/a', { extract })).toEqual({
      kind: 'failed',
      reason: 'no article extracted',
    });
  });

  it('reports a failure when the extracted body is too short to be useful', async () => {
    const extract = vi.fn().mockResolvedValue({ content: '<p>Subscribe to read.</p>' });
    const out = await fetchArticleContent('https://example.com/a', { extract });
    expect(out).toEqual({ kind: 'failed', reason: 'content too short' });
  });

  it('caps very long bodies so one article cannot bloat a row', async () => {
    const extract = vi.fn().mockResolvedValue({ content: '<p>' + 'x'.repeat(500_000) + '</p>' });
    const out = await fetchArticleContent('https://example.com/a', { extract });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.text.length).toBe(CONTENT_MAX_BYTES);
  });

  it('converts a thrown error into a failure reason rather than propagating', async () => {
    const extract = vi.fn().mockRejectedValue(new Error('403 Forbidden'));
    expect(await fetchArticleContent('https://example.com/a', { extract })).toEqual({
      kind: 'failed',
      reason: '403 Forbidden',
    });
  });

  it('rejects a non-http URL without calling the extractor', async () => {
    const extract = vi.fn();
    const out = await fetchArticleContent('javascript:alert(1)', { extract });
    expect(out).toEqual({ kind: 'failed', reason: 'unsupported url scheme' });
    expect(extract).not.toHaveBeenCalled();
  });

  it('rejects an empty URL', async () => {
    const extract = vi.fn();
    expect(await fetchArticleContent('', { extract })).toEqual({
      kind: 'failed',
      reason: 'unsupported url scheme',
    });
  });

  it('collapses runaway whitespace in the extracted text', async () => {
    const extract = vi.fn().mockResolvedValue({
      content: '<p>Line one.</p>\n\n\n\n<p>Line two with plenty of words to clear the length floor here.</p>',
    });
    const out = await fetchArticleContent('https://example.com/a', { extract });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.text).not.toMatch(/\n{3,}/);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter data-pipeline test rssContent`
Expected: FAIL — cannot resolve `./rssContent`.

- [ ] **Step 4: Write the extractor wrapper**

Create `data-pipeline/src/lib/rssContent.ts`:

```ts
/**
 * Full-article text extraction for LLM-selected items.
 *
 * Only the selected subset (~75/day) is fetched, so this is polite by
 * construction. Paywalled and robots-blocked pages simply fail and exhaust
 * their attempt budget — nothing here attempts to circumvent access controls.
 */
import { extract } from '@extractus/article-extractor';

export const CONTENT_TIMEOUT_MS = 15_000;
/** Hard cap on stored article text. Long-read features rarely exceed ~60 KB. */
export const CONTENT_MAX_BYTES = 200_000;
/** Attempts before an item is marked `failed` and stops being retried. */
export const MAX_CONTENT_ATTEMPTS = 3;
/** Below this, the "article" is almost certainly a paywall or consent screen. */
const MIN_USEFUL_LENGTH = 200;

export type ContentOutcome = { kind: 'ok'; text: string } | { kind: 'failed'; reason: string };

export interface ContentDeps {
  extract?: (url: string, options?: unknown) => Promise<{ content?: string } | null>;
  timeoutMs?: number;
}

export async function fetchArticleContent(
  url: string,
  deps: ContentDeps = {},
): Promise<ContentOutcome> {
  if (!/^https?:\/\//i.test(url)) return { kind: 'failed', reason: 'unsupported url scheme' };

  const extractImpl = deps.extract ?? extract;

  try {
    const article = await extractImpl(url, {
      descriptionTruncateLen: 0,
      contentLengthThreshold: 0,
      timeout: deps.timeoutMs ?? CONTENT_TIMEOUT_MS,
    });
    if (!article?.content) return { kind: 'failed', reason: 'no article extracted' };

    const text = toPlainText(article.content);
    if (text.length < MIN_USEFUL_LENGTH) return { kind: 'failed', reason: 'content too short' };

    return { kind: 'ok', text: text.slice(0, CONTENT_MAX_BYTES) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: 'failed', reason: reason.slice(0, 200) };
  }
}

function toPlainText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    // Block-level tags become paragraph breaks so the chunker has real boundaries.
    .replace(/<\/(p|div|h[1-6]|li|br)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter data-pipeline test rssContent`
Expected: PASS — 8 tests.

- [ ] **Step 6: Commit**

```bash
git add data-pipeline/src/lib/rssContent.ts data-pipeline/src/lib/rssContent.test.ts \
        data-pipeline/package.json pnpm-lock.yaml
git commit -m "feat(rss): add article content extraction with attempt budget"
```

---

### Task 13: Chunking and Bedrock embeddings

**Files:**
- Create: `src/lib/bedrock.ts`
- Create: `src/lib/bedrock.test.ts`
- Create: `data-pipeline/src/lib/rssChunk.ts`
- Create: `data-pipeline/src/lib/rssChunk.test.ts`
- Modify: `package.json` (add `@aws-sdk/client-bedrock-runtime`)
- Modify: `data-pipeline/scripts/build.ts` (keep the Bedrock client bundled)

**Interfaces:**
- Produces:
  - `src/lib/bedrock.ts`: `class BedrockEmbeddingClient { constructor(opts?: BedrockEmbeddingOptions) }` with `embed(text: string): Promise<number[]>` and `embedMany(texts: string[]): Promise<number[][]>`; `const EMBEDDING_DIMENSIONS = 1024`; `const DEFAULT_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0'`.
  - `data-pipeline/src/lib/rssChunk.ts`: `chunkArticle(title: string, body: string, opts?): string[]`; `const CHUNK_CHARS = 4800`, `const CHUNK_OVERLAP_CHARS = 600`.

Both live where they do on purpose: the Bedrock client is shared (the app embeds search queries, the Lambda embeds documents), the chunker is pipeline-only.

- [ ] **Step 1: Add the Bedrock SDK to the app package**

```bash
pnpm add @aws-sdk/client-bedrock-runtime
```

The `data-pipeline` package resolves `@/lib/*` to the app's `src/`, so it picks this up through the existing alias — no second install needed.

- [ ] **Step 2: Write the failing Bedrock test**

Create `src/lib/bedrock.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { BedrockEmbeddingClient, EMBEDDING_DIMENSIONS } from './bedrock';

function bedrockResponse(embedding: number[]) {
  return { body: new TextEncoder().encode(JSON.stringify({ embedding })) };
}

const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01);

describe('BedrockEmbeddingClient.embed', () => {
  it('returns the embedding vector from the model response', async () => {
    const send = vi.fn().mockResolvedValue(bedrockResponse(vector));
    const client = new BedrockEmbeddingClient({ send });

    expect(await client.embed('hello')).toEqual(vector);
  });

  it('asks Titan for the dimension count the schema expects', async () => {
    const send = vi.fn().mockResolvedValue(bedrockResponse(vector));
    const client = new BedrockEmbeddingClient({ send });

    await client.embed('hello');

    const body = JSON.parse(send.mock.calls[0][0].input.body as string);
    expect(body).toEqual({ inputText: 'hello', dimensions: EMBEDDING_DIMENSIONS, normalize: true });
  });

  it('rejects an empty input rather than sending a useless call', async () => {
    const send = vi.fn();
    const client = new BedrockEmbeddingClient({ send });

    await expect(client.embed('   ')).rejects.toThrow('cannot embed empty text');
    expect(send).not.toHaveBeenCalled();
  });

  it('throws when the model returns a vector of the wrong width', async () => {
    const send = vi.fn().mockResolvedValue(bedrockResponse([0.1, 0.2]));
    const client = new BedrockEmbeddingClient({ send });

    await expect(client.embed('hello')).rejects.toThrow(/expected 1024/);
  });

  it('throws a clear error when the response body is not valid JSON', async () => {
    const send = vi.fn().mockResolvedValue({ body: new TextEncoder().encode('not json') });
    const client = new BedrockEmbeddingClient({ send });

    await expect(client.embed('hello')).rejects.toThrow(/bedrock/i);
  });

  it('truncates input beyond the model token ceiling instead of erroring', async () => {
    const send = vi.fn().mockResolvedValue(bedrockResponse(vector));
    const client = new BedrockEmbeddingClient({ send });

    await client.embed('x'.repeat(100_000));

    const body = JSON.parse(send.mock.calls[0][0].input.body as string);
    expect(body.inputText.length).toBeLessThanOrEqual(32_000);
  });
});

describe('BedrockEmbeddingClient.embedMany', () => {
  it('embeds each text and preserves order', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(bedrockResponse(vector.map(() => 0.1)))
      .mockResolvedValueOnce(bedrockResponse(vector.map(() => 0.2)));
    const client = new BedrockEmbeddingClient({ send });

    const out = await client.embedMany(['a', 'b']);

    expect(out).toHaveLength(2);
    expect(out[0][0]).toBe(0.1);
    expect(out[1][0]).toBe(0.2);
  });

  it('returns [] without calling the model for an empty list', async () => {
    const send = vi.fn();
    const client = new BedrockEmbeddingClient({ send });

    expect(await client.embedMany([])).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run src/lib/bedrock.test.ts`
Expected: FAIL — cannot resolve `./bedrock`.

- [ ] **Step 4: Write the Bedrock client**

Create `src/lib/bedrock.ts`:

```ts
/**
 * Amazon Bedrock text embeddings (Titan Embed v2).
 *
 * Shared by the ingest Lambda (embedding article chunks) and the app
 * (embedding a search query) so both sides always use the same model and
 * dimension count — a mismatch would silently return garbage neighbours.
 *
 * IMPORTANT: Bedrock is NOT available in ap-southeast-3 (Jakarta), where the
 * pipeline Lambdas run. The region therefore comes from BEDROCK_REGION and
 * defaults to ap-southeast-1, never from AWS_REGION.
 */
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

export const EMBEDDING_DIMENSIONS = 1024;
export const DEFAULT_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';
export const DEFAULT_BEDROCK_REGION = 'ap-southeast-1';
/** Titan v2 accepts ~8k tokens; ~32k characters is a safe ceiling. */
const MAX_INPUT_CHARS = 32_000;

export interface BedrockEmbeddingOptions {
  /** Injected in tests; defaults to a real BedrockRuntimeClient. */
  send?: (command: InvokeModelCommand) => Promise<{ body: Uint8Array }>;
  modelId?: string;
  region?: string;
}

export class BedrockEmbeddingClient {
  private readonly modelId: string;
  private readonly region: string;
  private readonly injectedSend?: BedrockEmbeddingOptions['send'];
  private client: BedrockRuntimeClient | null = null;

  constructor(opts: BedrockEmbeddingOptions = {}) {
    this.modelId = opts.modelId ?? process.env.BEDROCK_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
    this.region = opts.region ?? process.env.BEDROCK_REGION ?? DEFAULT_BEDROCK_REGION;
    this.injectedSend = opts.send;
  }

  async embed(text: string): Promise<number[]> {
    const inputText = text.trim().slice(0, MAX_INPUT_CHARS);
    if (inputText.length === 0) throw new Error('cannot embed empty text');

    const command = new InvokeModelCommand({
      modelId: this.modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        inputText,
        dimensions: EMBEDDING_DIMENSIONS,
        normalize: true,
      }),
    });

    const response = await this.send(command);

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(response.body));
    } catch {
      throw new Error('bedrock returned a non-JSON embedding response');
    }

    const embedding = (parsed as { embedding?: unknown }).embedding;
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `bedrock returned ${Array.isArray(embedding) ? embedding.length : 'no'} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
      );
    }
    return embedding as number[];
  }

  /**
   * Sequential on purpose: Titan has no batch endpoint, and the caller already
   * bounds how many items reach here per run. Order matches the input.
   */
  async embedMany(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const text of texts) out.push(await this.embed(text));
    return out;
  }

  private send(command: InvokeModelCommand): Promise<{ body: Uint8Array }> {
    if (this.injectedSend) return this.injectedSend(command);
    this.client ??= new BedrockRuntimeClient({ region: this.region });
    return this.client.send(command) as unknown as Promise<{ body: Uint8Array }>;
  }
}
```

- [ ] **Step 5: Run the Bedrock tests**

Run: `pnpm vitest run src/lib/bedrock.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 6: Write the failing chunker test**

Create `data-pipeline/src/lib/rssChunk.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { chunkArticle, CHUNK_CHARS, CHUNK_OVERLAP_CHARS } from './rssChunk';

describe('chunkArticle', () => {
  it('returns a single chunk for a short article', () => {
    const chunks = chunkArticle('Acme raises $40m', 'A short body.');
    expect(chunks).toHaveLength(1);
  });

  it('prefixes every chunk with the title so each is independently retrievable', () => {
    const chunks = chunkArticle('Acme raises $40m', 'word '.repeat(4000));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.startsWith('Acme raises $40m'))).toBe(true);
  });

  it('splits long bodies into multiple chunks', () => {
    const chunks = chunkArticle('T', 'x'.repeat(CHUNK_CHARS * 3));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it('overlaps consecutive chunks so a sentence on a boundary is not lost', () => {
    const body = Array.from({ length: 3000 }, (_, i) => `token${i}`).join(' ');
    const chunks = chunkArticle('T', body);
    const firstTail = chunks[0].slice(-CHUNK_OVERLAP_CHARS / 2);
    expect(chunks[1]).toContain(firstTail.trim().split(' ').slice(-3).join(' '));
  });

  it('falls back to the title alone when the body is empty', () => {
    expect(chunkArticle('Only a title', '')).toEqual(['Only a title']);
  });

  it('returns [] when there is neither title nor body', () => {
    expect(chunkArticle('', '')).toEqual([]);
  });

  it('never emits a blank chunk', () => {
    const chunks = chunkArticle('T', '\n\n\n   \n\n');
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
  });

  it('caps the number of chunks so one enormous page cannot flood the index', () => {
    const chunks = chunkArticle('T', 'x'.repeat(CHUNK_CHARS * 100));
    expect(chunks.length).toBeLessThanOrEqual(40);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter data-pipeline test rssChunk`
Expected: FAIL — cannot resolve `./rssChunk`.

- [ ] **Step 8: Write the chunker**

Create `data-pipeline/src/lib/rssChunk.ts`:

```ts
/**
 * Split an article into overlapping, embeddable chunks.
 *
 * Character-based rather than token-based: no tokenizer dependency, and at
 * ~4 chars/token 4800 chars ≈ 1200 tokens, which is the target chunk size
 * from the design. The title is prefixed to every chunk so a mid-article
 * chunk still carries the subject when it comes back from a vector search.
 */
export const CHUNK_CHARS = 4800;
export const CHUNK_OVERLAP_CHARS = 600;
/** Ceiling per article, so a pathological page can't dominate the index. */
export const MAX_CHUNKS = 40;

export interface ChunkOptions {
  chunkChars?: number;
  overlapChars?: number;
  maxChunks?: number;
}

export function chunkArticle(title: string, body: string, opts: ChunkOptions = {}): string[] {
  const chunkChars = opts.chunkChars ?? CHUNK_CHARS;
  const overlap = Math.min(opts.overlapChars ?? CHUNK_OVERLAP_CHARS, chunkChars - 1);
  const maxChunks = opts.maxChunks ?? MAX_CHUNKS;

  const cleanTitle = title.trim();
  const cleanBody = body.trim();

  if (cleanBody.length === 0) return cleanTitle.length > 0 ? [cleanTitle] : [];

  const prefix = cleanTitle.length > 0 ? `${cleanTitle}\n\n` : '';
  const room = Math.max(1, chunkChars - prefix.length);

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < cleanBody.length && chunks.length < maxChunks) {
    const end = Math.min(cursor + room, cleanBody.length);
    // Prefer a whitespace boundary so chunks don't split mid-word, but only
    // when one exists reasonably close to the target end.
    const slice = cleanBody.slice(cursor, end);
    const boundary =
      end < cleanBody.length ? slice.lastIndexOf(' ', room) : slice.length;
    const cut = boundary > room * 0.6 ? boundary : slice.length;

    const text = `${prefix}${slice.slice(0, cut)}`.trim();
    if (text.length > 0) chunks.push(text);

    const advance = Math.max(1, cut - overlap);
    cursor += advance;
  }

  return chunks;
}
```

- [ ] **Step 9: Run the chunker tests**

Run: `pnpm --filter data-pipeline test rssChunk`
Expected: PASS — 8 tests.

- [ ] **Step 10: Keep the Bedrock client bundled into the Lambda**

`@aws-sdk/client-bedrock-runtime` is **not** part of the Lambda nodejs runtime, so it must be bundled rather than externalized. Confirm it is absent from the `external` array in `data-pipeline/scripts/build.ts` — the array should still list only the seven `client-s3`/`client-ssm`/`client-sns`/`client-sqs`/`client-dynamodb`/`client-sts`/`client-lambda` entries. Do not add Bedrock to it.

Run: `grep -c "bedrock" data-pipeline/scripts/build.ts`
Expected: `0`

- [ ] **Step 11: Commit**

```bash
git add src/lib/bedrock.ts src/lib/bedrock.test.ts \
        data-pipeline/src/lib/rssChunk.ts data-pipeline/src/lib/rssChunk.test.ts \
        package.json pnpm-lock.yaml
git commit -m "feat(rss): add Bedrock Titan embedding client and article chunker"
```

---

### Task 14: Enrichment repository methods

**Files:**
- Modify: `data-pipeline/src/repositories/rssRepository.ts`
- Modify: `data-pipeline/src/repositories/rssRepository.test.ts`

**Interfaces:**
- Consumes: the class from Task 7.
- Produces, on `RssRepository`:
  - `listPendingClassification(limit: number): Promise<ClassifiableItem[]>`
  - `countSelectedToday(): Promise<Record<string, number>>`
  - `applyClassifications(decisions: SelectionDecision[]): Promise<void>`
  - `listPendingContent(limit: number): Promise<ContentQueueRow[]>` where `ContentQueueRow = { id; link; title; summary }`
  - `recordContentSuccess(id: string, text: string): Promise<void>`
  - `recordContentFailure(id: string, reason: string): Promise<void>`
  - `listPendingEmbedding(limit: number): Promise<EmbeddableRow[]>` where `EmbeddableRow = { id; title; content_text; summary; content_status }`
  - `saveChunks(itemId: string, chunks: { text: string; embedding: number[] }[]): Promise<void>`

- [ ] **Step 1: Add the failing tests**

Append to `data-pipeline/src/repositories/rssRepository.test.ts`:

```ts
describe('RssRepository.countSelectedToday', () => {
  beforeEach(resetDb);

  it('returns a per-category map of today’s selections', async () => {
    mockDb.execute.mockResolvedValueOnce({
      rows: [
        { category: 'new_funding', count: '4' },
        { category: 'ma_partnerships', count: '25' },
      ],
    });
    const repo = new RssRepository(mockDb as never);

    expect(await repo.countSelectedToday()).toEqual({
      new_funding: 4,
      ma_partnerships: 25,
    });
  });

  it('counts only rows selected since the start of the UTC day', async () => {
    mockDb.execute.mockResolvedValueOnce({ rows: [] });
    const repo = new RssRepository(mockDb as never);

    await repo.countSelectedToday();

    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain("date_trunc('day', now() AT TIME ZONE 'UTC')");
    expect(text).toContain("relevance = 'selected'");
  });
});

describe('RssRepository.applyClassifications', () => {
  beforeEach(resetDb);

  it('does nothing for an empty decision list', async () => {
    const repo = new RssRepository(mockDb as never);
    await repo.applyClassifications([]);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('writes every decision in one statement', async () => {
    const repo = new RssRepository(mockDb as never);

    await repo.applyClassifications([
      { id: 'i1', relevance: 'selected', score: 0.9, labels: { companies: [], topics: [], reason: 'r' } },
      { id: 'i2', relevance: 'rejected', score: 0.1, labels: { companies: [], topics: [], reason: 'r' } },
    ]);

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain('UPDATE rss.items');
    expect(text).toContain('jsonb_to_recordset');
  });

  it('queues selected items for content fetching and leaves rejected ones alone', async () => {
    const repo = new RssRepository(mockDb as never);

    await repo.applyClassifications([
      { id: 'i1', relevance: 'selected', score: 0.9, labels: { companies: [], topics: [], reason: 'r' } },
    ]);

    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain("WHEN u.relevance = 'selected' THEN 'pending'");
  });
});

describe('RssRepository content bookkeeping', () => {
  beforeEach(resetDb);

  it('recordContentSuccess stores the text and stamps the fetch time', async () => {
    updateChain.where.mockResolvedValueOnce(undefined);
    const repo = new RssRepository(mockDb as never);

    await repo.recordContentSuccess('i1', 'body');

    const setArg = updateChain.set.mock.calls[0][0];
    expect(setArg.content_text).toBe('body');
    expect(setArg.content_status).toBe('fetched');
    expect(setArg.content_error).toBeNull();
  });

  it('recordContentFailure increments attempts and only gives up at the budget', async () => {
    mockDb.execute.mockResolvedValueOnce({ rows: [] });
    const repo = new RssRepository(mockDb as never);

    await repo.recordContentFailure('i1', 'http 403');

    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain('content_attempts + 1');
    expect(text).toContain("'failed'");
    expect(text).toContain("'pending'");
  });
});

describe('RssRepository.saveChunks', () => {
  beforeEach(resetDb);

  it('does nothing when there are no chunks', async () => {
    const repo = new RssRepository(mockDb as never);
    await repo.saveChunks('i1', []);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('numbers chunks sequentially and stamps the item as embedded', async () => {
    insertChain.onConflictDoNothing.mockResolvedValueOnce(undefined);
    updateChain.where.mockResolvedValueOnce(undefined);
    const repo = new RssRepository(mockDb as never);

    await repo.saveChunks('i1', [
      { text: 'a', embedding: [0.1] },
      { text: 'b', embedding: [0.2] },
    ]);

    const values = insertChain.values.mock.calls[0][0];
    expect(values.map((v: { chunk_index: number }) => v.chunk_index)).toEqual([0, 1]);
    expect(updateChain.set.mock.calls[0][0].embedded_at).toBeDefined();
  });

  it('is safe to re-run: chunk inserts ignore conflicts', async () => {
    insertChain.onConflictDoNothing.mockResolvedValueOnce(undefined);
    updateChain.where.mockResolvedValueOnce(undefined);
    const repo = new RssRepository(mockDb as never);

    await repo.saveChunks('i1', [{ text: 'a', embedding: [0.1] }]);

    expect(insertChain.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `pnpm --filter data-pipeline test rssRepository`
Expected: the Task 7 tests still pass; the new ones FAIL with `repo.countSelectedToday is not a function` etc.

- [ ] **Step 3: Add the methods**

Add these imports at the top of `data-pipeline/src/repositories/rssRepository.ts`:

```ts
import { rssItemChunks } from '@/lib/db/schema';
import type { RssCategory } from '@/lib/db/schema';
import type { ClassifiableItem, SelectionDecision } from '../handlers/rssClassify';
import { MAX_CONTENT_ATTEMPTS } from '../lib/rssContent';
```

Add these types above the class:

```ts
export interface ContentQueueRow {
  id: string;
  link: string;
  title: string;
  summary: string | null;
}

export interface EmbeddableRow {
  id: string;
  title: string;
  content_text: string | null;
  summary: string | null;
  content_status: string;
}
```

Add these methods inside `RssRepository`:

```ts
  /** Oldest-first so a backlog drains in publication order. */
  async listPendingClassification(limit: number): Promise<ClassifiableItem[]> {
    return this.db
      .select({
        id: rssItems.id,
        category: rssItems.category,
        source_name: rssItems.source_name,
        feed_tier: rssItems.feed_tier,
        title: rssItems.title,
        summary: rssItems.summary,
      })
      .from(rssItems)
      .where(eq(rssItems.relevance, 'pending'))
      .orderBy(asc(rssItems.ingested_at))
      .limit(limit) as Promise<ClassifiableItem[]>;
  }

  /**
   * Today's selections per category, for the daily cap. Counted in UTC so the
   * budget resets at the same instant as the ingest_date partitions in bronze.
   */
  async countSelectedToday(): Promise<Record<string, number>> {
    const result = await this.db.execute(sql`
      SELECT category, count(*)::text AS count
      FROM rss.items
      WHERE relevance = 'selected'
        AND classified_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
      GROUP BY category
    `);
    const rows = queryRows<{ category: string; count: string }>(result);
    return Object.fromEntries(rows.map((r) => [r.category, Number(r.count)]));
  }

  /**
   * Persist a batch of verdicts in one statement. Selecting an item also
   * enqueues it for content fetching, so classification and queueing can never
   * drift apart.
   */
  async applyClassifications(decisions: SelectionDecision[]): Promise<void> {
    if (decisions.length === 0) return;

    const payload = JSON.stringify(
      decisions.map((d) => ({
        id: d.id,
        relevance: d.relevance,
        score: d.score,
        labels: d.labels,
      })),
    );

    await this.db.execute(sql`
      UPDATE rss.items AS i SET
        relevance = u.relevance,
        relevance_score = u.score,
        llm_labels = u.labels,
        classified_at = now(),
        content_status = CASE WHEN u.relevance = 'selected' THEN 'pending' ELSE i.content_status END
      FROM jsonb_to_recordset(${payload}::jsonb)
        AS u(id uuid, relevance text, score real, labels jsonb)
      WHERE i.id = u.id
    `);
  }

  async listPendingContent(limit: number): Promise<ContentQueueRow[]> {
    return this.db
      .select({
        id: rssItems.id,
        link: rssItems.link,
        title: rssItems.title,
        summary: rssItems.summary,
      })
      .from(rssItems)
      .where(and(eq(rssItems.relevance, 'selected'), eq(rssItems.content_status, 'pending')))
      .orderBy(asc(rssItems.ingested_at))
      .limit(limit) as Promise<ContentQueueRow[]>;
  }

  async recordContentSuccess(id: string, text: string): Promise<void> {
    await this.db
      .update(rssItems)
      .set({
        content_text: text,
        content_status: 'fetched',
        content_fetched_at: sql`now()`,
        content_error: null,
      })
      .where(eq(rssItems.id, id));
  }

  /**
   * Burn one attempt. The item stays `pending` (and therefore retryable) until
   * the budget is spent, then goes `failed` so it stops being picked up — the
   * UI still lists it with its summary and a link to the original.
   */
  async recordContentFailure(id: string, reason: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE rss.items SET
        content_attempts = content_attempts + 1,
        content_error = ${reason.slice(0, 500)},
        content_status = CASE
          WHEN content_attempts + 1 >= ${MAX_CONTENT_ATTEMPTS} THEN 'failed'
          ELSE 'pending'
        END
      WHERE id = ${id}::uuid
    `);
  }

  /**
   * Items ready to embed: successfully fetched, or terminally failed (those
   * get a title+summary chunk so RAG recall degrades gracefully instead of
   * dropping the story entirely).
   */
  async listPendingEmbedding(limit: number): Promise<EmbeddableRow[]> {
    const result = await this.db.execute(sql`
      SELECT id, title, content_text, summary, content_status
      FROM rss.items
      WHERE relevance = 'selected'
        AND embedded_at IS NULL
        AND content_status IN ('fetched', 'failed')
      ORDER BY ingested_at ASC
      LIMIT ${limit}
    `);
    return queryRows<EmbeddableRow>(result);
  }

  async saveChunks(
    itemId: string,
    chunks: { text: string; embedding: number[] }[],
  ): Promise<void> {
    if (chunks.length === 0) return;

    await this.db
      .insert(rssItemChunks)
      .values(
        chunks.map((chunk, chunk_index) => ({
          item_id: itemId,
          chunk_index,
          text: chunk.text,
          embedding: chunk.embedding,
        })),
      )
      .onConflictDoNothing();

    await this.db
      .update(rssItems)
      .set({ embedded_at: sql`now()` })
      .where(eq(rssItems.id, itemId));
  }
```

Add this helper at the bottom of the file (mirrors `queryRows` in `emailProcess.ts` — `db.execute` returns a driver-shaped result):

```ts
function queryRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter data-pipeline test rssRepository`
Expected: PASS — all tests (10 from Task 7 plus 10 new).

- [ ] **Step 5: Commit**

```bash
git add data-pipeline/src/repositories/rssRepository.ts data-pipeline/src/repositories/rssRepository.test.ts
git commit -m "feat(rss): add classification, content and embedding queries to RssRepository"
```

---

### Task 15: `rss-enrich` Lambda

**Files:**
- Create: `data-pipeline/src/lambda/rssEnrich.ts`
- Create: `data-pipeline/src/lambda/rssEnrich.test.ts`
- Modify: `data-pipeline/scripts/build.ts`
- Modify: `data-pipeline/template.yaml`
- Modify: `data-pipeline/terraform/pipeline-compute/main.tf`
- Modify: `data-pipeline/terraform/pipeline-compute/iam.tf`

**Interfaces:**
- Consumes: everything from Tasks 11–14.
- Produces: `export const handler` returning `{ ok, result }` with `RssEnrichResult = { run_id, classified, selected, content_fetched, content_failed, items_embedded, chunks_written }`.

- [ ] **Step 1: Write the failing test**

Create `data-pipeline/src/lambda/rssEnrich.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadSecretsFromSsm: vi.fn().mockResolvedValue(undefined),
  createLambdaDb: vi.fn(),
  pgClientEnd: vi.fn().mockResolvedValue(undefined),
  listPendingClassification: vi.fn().mockResolvedValue([]),
  countSelectedToday: vi.fn().mockResolvedValue({}),
  applyClassifications: vi.fn().mockResolvedValue(undefined),
  listPendingContent: vi.fn().mockResolvedValue([]),
  recordContentSuccess: vi.fn().mockResolvedValue(undefined),
  recordContentFailure: vi.fn().mockResolvedValue(undefined),
  listPendingEmbedding: vi.fn().mockResolvedValue([]),
  saveChunks: vi.fn().mockResolvedValue(undefined),
  startRun: vi.fn().mockResolvedValue('run-1'),
  finishRun: vi.fn().mockResolvedValue(undefined),
  classifyBatch: vi.fn().mockResolvedValue([]),
  fetchArticleContent: vi.fn(),
  embed: vi.fn(),
}));

vi.mock('../secrets', () => ({ loadSecretsFromSsm: mocks.loadSecretsFromSsm }));
vi.mock('../db', () => ({ createLambdaDb: mocks.createLambdaDb }));
vi.mock('../repositories', () => ({
  RssRepository: class {
    listPendingClassification = mocks.listPendingClassification;
    countSelectedToday = mocks.countSelectedToday;
    applyClassifications = mocks.applyClassifications;
    listPendingContent = mocks.listPendingContent;
    recordContentSuccess = mocks.recordContentSuccess;
    recordContentFailure = mocks.recordContentFailure;
    listPendingEmbedding = mocks.listPendingEmbedding;
    saveChunks = mocks.saveChunks;
    startRun = mocks.startRun;
    finishRun = mocks.finishRun;
  },
}));
vi.mock('../handlers/rssClassify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../handlers/rssClassify')>();
  return { ...actual, classifyBatch: mocks.classifyBatch };
});
vi.mock('../lib/rssContent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/rssContent')>();
  return { ...actual, fetchArticleContent: mocks.fetchArticleContent };
});
vi.mock('@/lib/bedrock', () => ({
  EMBEDDING_DIMENSIONS: 1024,
  BedrockEmbeddingClient: class {
    embed = mocks.embed;
  },
}));

import { handler } from './rssEnrich';

function pending(id: string, category = 'new_funding') {
  return {
    id,
    category,
    source_name: 'Wire',
    feed_tier: 'curated' as const,
    title: `Title ${id}`,
    summary: 'Summary',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createLambdaDb.mockResolvedValue({ pgClient: { end: mocks.pgClientEnd }, db: {} });
  mocks.startRun.mockResolvedValue('run-1');
  mocks.listPendingClassification.mockResolvedValue([]);
  mocks.listPendingContent.mockResolvedValue([]);
  mocks.listPendingEmbedding.mockResolvedValue([]);
  mocks.countSelectedToday.mockResolvedValue({});
  mocks.embed.mockResolvedValue(Array.from({ length: 1024 }, () => 0.01));
});

describe('rss-enrich — classification stage', () => {
  it('classifies pending items and persists the decisions', async () => {
    mocks.listPendingClassification.mockResolvedValue([pending('i1')]);
    mocks.classifyBatch.mockResolvedValue([
      { index: 0, relevant: true, score: 0.9, companies: [], topics: [], reason: 'r' },
    ]);

    const out = await handler({}, {});

    expect(out.result.classified).toBe(1);
    expect(out.result.selected).toBe(1);
    expect(mocks.applyClassifications).toHaveBeenCalledTimes(1);
  });

  it('respects the remaining daily cap for a category', async () => {
    process.env.RSS_DAILY_CAP_PER_CATEGORY = '2';
    mocks.listPendingClassification.mockResolvedValue([pending('i1'), pending('i2')]);
    // One already selected today, so only one slot remains.
    mocks.countSelectedToday.mockResolvedValue({ new_funding: 1 });
    mocks.classifyBatch.mockResolvedValue([
      { index: 0, relevant: true, score: 0.95, companies: [], topics: [], reason: 'r' },
      { index: 1, relevant: true, score: 0.9, companies: [], topics: [], reason: 'r' },
    ]);

    const out = await handler({}, {});

    expect(out.result.selected).toBe(1);
    delete process.env.RSS_DAILY_CAP_PER_CATEGORY;
  });

  it('skips the whole stage when nothing is pending', async () => {
    await handler({}, {});
    expect(mocks.classifyBatch).not.toHaveBeenCalled();
    expect(mocks.applyClassifications).not.toHaveBeenCalled();
  });
});

describe('rss-enrich — content stage', () => {
  it('stores fetched article text', async () => {
    mocks.listPendingContent.mockResolvedValue([
      { id: 'i1', link: 'https://example.com/a', title: 'T', summary: 'S' },
    ]);
    mocks.fetchArticleContent.mockResolvedValue({ kind: 'ok', text: 'Full body text' });

    const out = await handler({}, {});

    expect(out.result.content_fetched).toBe(1);
    expect(mocks.recordContentSuccess).toHaveBeenCalledWith('i1', 'Full body text');
  });

  it('burns an attempt on failure without aborting the other items', async () => {
    mocks.listPendingContent.mockResolvedValue([
      { id: 'i1', link: 'https://example.com/a', title: 'T', summary: 'S' },
      { id: 'i2', link: 'https://example.com/b', title: 'T', summary: 'S' },
    ]);
    mocks.fetchArticleContent
      .mockResolvedValueOnce({ kind: 'failed', reason: 'http 403' })
      .mockResolvedValueOnce({ kind: 'ok', text: 'Body' });

    const out = await handler({}, {});

    expect(out.result.content_failed).toBe(1);
    expect(out.result.content_fetched).toBe(1);
    expect(mocks.recordContentFailure).toHaveBeenCalledWith('i1', 'http 403');
  });
});

describe('rss-enrich — embedding stage', () => {
  it('embeds each chunk of a fetched article and saves them', async () => {
    mocks.listPendingEmbedding.mockResolvedValue([
      { id: 'i1', title: 'T', content_text: 'Body text here.', summary: 'S', content_status: 'fetched' },
    ]);

    const out = await handler({}, {});

    expect(out.result.items_embedded).toBe(1);
    expect(out.result.chunks_written).toBeGreaterThan(0);
    expect(mocks.saveChunks).toHaveBeenCalledTimes(1);
  });

  it('falls back to title+summary for an item whose content fetch terminally failed', async () => {
    mocks.listPendingEmbedding.mockResolvedValue([
      { id: 'i1', title: 'Acme raises', content_text: null, summary: 'A funding round.', content_status: 'failed' },
    ]);

    await handler({}, {});

    const chunks = mocks.saveChunks.mock.calls[0][1] as { text: string }[];
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('A funding round.');
  });

  it('leaves an item unembedded when Bedrock fails, so a later run retries it', async () => {
    mocks.listPendingEmbedding.mockResolvedValue([
      { id: 'i1', title: 'T', content_text: 'Body', summary: 'S', content_status: 'fetched' },
    ]);
    mocks.embed.mockRejectedValue(new Error('throttled'));

    const out = await handler({}, {});

    expect(out.ok).toBe(true);
    expect(out.result.items_embedded).toBe(0);
    expect(mocks.saveChunks).not.toHaveBeenCalled();
  });
});

describe('rss-enrich — run bookkeeping', () => {
  it('records the run and closes the pg client', async () => {
    await handler({}, {});
    expect(mocks.startRun).toHaveBeenCalledWith('enrich');
    expect(mocks.finishRun).toHaveBeenCalledWith('run-1', expect.any(Object), null);
    expect(mocks.pgClientEnd).toHaveBeenCalledTimes(1);
  });

  it('records the error and rethrows when a stage blows up', async () => {
    mocks.listPendingClassification.mockRejectedValue(new Error('db down'));

    await expect(handler({}, {})).rejects.toThrow('db down');

    expect(mocks.finishRun).toHaveBeenCalledWith('run-1', expect.any(Object), 'db down');
    expect(mocks.pgClientEnd).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter data-pipeline test rssEnrich`
Expected: FAIL — cannot resolve `./rssEnrich`.

- [ ] **Step 3: Write the Lambda**

Create `data-pipeline/src/lambda/rssEnrich.ts`:

```ts
/**
 * rss-enrich — scheduled every 10 minutes.
 *
 * Drains three independent queues, each bounded so the run stays well inside
 * the Lambda timeout and a failure in one stage never blocks the others:
 *
 *   1. classify — Haiku scores pending items; tier thresholds + the daily
 *      per-category cap decide what gets selected.
 *   2. content  — fetch the article body for selected items (3 attempts).
 *   3. embed    — chunk + Bedrock Titan, into rss.item_chunks.
 *
 * Every stage is idempotent: work is claimed by status columns, so a crashed
 * run simply leaves items in their previous state for the next invocation.
 */
import { loadSecretsFromSsm } from '../secrets';
import { createLambdaDb } from '../db';
import { RssRepository } from '../repositories';
import {
  classifyBatch,
  decideSelections,
  CLASSIFY_BATCH_SIZE,
  type ClassifiableItem,
  type SelectionDecision,
} from '../handlers/rssClassify';
import { fetchArticleContent } from '../lib/rssContent';
import { chunkArticle } from '../lib/rssChunk';
import { mapWithConcurrency } from '../lib/rssFetch';
import { BedrockEmbeddingClient } from '@/lib/bedrock';
import { RSS_CATEGORIES, type RssCategory } from '@/lib/db/schema';
import { pipelineLog, pipelineError } from '../lib/pipelineLog';

const SCOPE = 'rss-enrich';

/** Per-run ceilings. Sized so a full run fits comfortably in 10 minutes. */
const CLASSIFY_LIMIT = 200;
const CONTENT_LIMIT = 50;
const EMBED_LIMIT = 25;
const CONTENT_CONCURRENCY = 5;
const DEFAULT_DAILY_CAP = 25;

export interface RssEnrichResult {
  run_id: string;
  classified: number;
  selected: number;
  content_fetched: number;
  content_failed: number;
  items_embedded: number;
  chunks_written: number;
}

export const handler = async (
  _event: unknown,
  _ctx: unknown,
): Promise<{ ok: boolean; result: RssEnrichResult }> => {
  await loadSecretsFromSsm();
  const { pgClient, db } = await createLambdaDb();
  const repo = new RssRepository(db);
  const runId = await repo.startRun('enrich');

  const result: RssEnrichResult = {
    run_id: runId,
    classified: 0,
    selected: 0,
    content_fetched: 0,
    content_failed: 0,
    items_embedded: 0,
    chunks_written: 0,
  };

  try {
    await runClassification(repo, result);
    await runContentFetch(repo, result);
    await runEmbedding(repo, result);

    await repo.finishRun(runId, toStats(result), null);
    pipelineLog(SCOPE, 'done', { run_id: runId, ...toStats(result) });
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await repo.finishRun(runId, toStats(result), message).catch(() => undefined);
    pipelineError(SCOPE, 'failed', err, { run_id: runId });
    throw err;
  } finally {
    await pgClient.end();
  }
};

async function runClassification(repo: RssRepository, result: RssEnrichResult): Promise<void> {
  const pending = await repo.listPendingClassification(CLASSIFY_LIMIT);
  if (pending.length === 0) return;

  const cap = Number(process.env.RSS_DAILY_CAP_PER_CATEGORY ?? DEFAULT_DAILY_CAP);
  const usedToday = await repo.countSelectedToday();
  // Remaining budget is shared across the batches in this run, so a big
  // backlog can't blow through the cap by splitting into several batches.
  const remaining: Partial<Record<RssCategory, number>> = {};
  for (const category of RSS_CATEGORIES) {
    remaining[category] = Math.max(0, cap - (usedToday[category] ?? 0));
  }

  const decisions: SelectionDecision[] = [];
  for (let offset = 0; offset < pending.length; offset += CLASSIFY_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + CLASSIFY_BATCH_SIZE) as ClassifiableItem[];
    const verdicts = await classifyBatch(batch);
    // A failed model call yields no verdicts; skip the batch so its items stay
    // `pending` and get retried, rather than being rejected by default.
    if (verdicts.length === 0) continue;

    const batchDecisions = decideSelections(verdicts, batch, remaining);
    for (const decision of batchDecisions) {
      if (decision.relevance !== 'selected') continue;
      const item = batch.find((i) => i.id === decision.id);
      if (!item) continue;
      remaining[item.category] = Math.max(0, (remaining[item.category] ?? 0) - 1);
    }
    decisions.push(...batchDecisions);
  }

  if (decisions.length === 0) return;
  await repo.applyClassifications(decisions);
  result.classified = decisions.length;
  result.selected = decisions.filter((d) => d.relevance === 'selected').length;
}

async function runContentFetch(repo: RssRepository, result: RssEnrichResult): Promise<void> {
  const queue = await repo.listPendingContent(CONTENT_LIMIT);
  if (queue.length === 0) return;

  await mapWithConcurrency(queue, CONTENT_CONCURRENCY, async (row) => {
    const outcome = await fetchArticleContent(row.link);
    if (outcome.kind === 'ok') {
      await repo.recordContentSuccess(row.id, outcome.text);
      result.content_fetched++;
    } else {
      await repo.recordContentFailure(row.id, outcome.reason);
      result.content_failed++;
    }
  });
}

async function runEmbedding(repo: RssRepository, result: RssEnrichResult): Promise<void> {
  const queue = await repo.listPendingEmbedding(EMBED_LIMIT);
  if (queue.length === 0) return;

  const bedrock = new BedrockEmbeddingClient();

  for (const row of queue) {
    // Items whose content fetch terminally failed still get one chunk from
    // title + summary, so a paywalled story is degraded in RAG, not absent.
    const body = row.content_text ?? row.summary ?? '';
    const texts = chunkArticle(row.title, body);
    if (texts.length === 0) continue;

    try {
      const chunks = [];
      for (const text of texts) {
        chunks.push({ text, embedding: await bedrock.embed(text) });
      }
      await repo.saveChunks(row.id, chunks);
      result.items_embedded++;
      result.chunks_written += chunks.length;
    } catch (err) {
      // Leave embedded_at NULL so the next run retries this item; one bad
      // article must not stall the queue behind it.
      pipelineError(SCOPE, 'embedding failed', err, { item_id: row.id });
    }
  }
}

function toStats(result: RssEnrichResult): Record<string, number> {
  return {
    classified: result.classified,
    selected: result.selected,
    content_fetched: result.content_fetched,
    content_failed: result.content_failed,
    items_embedded: result.items_embedded,
    chunks_written: result.chunks_written,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter data-pipeline test rssEnrich`
Expected: PASS — 11 tests.

- [ ] **Step 5: Register in the bundler and SAM**

`data-pipeline/scripts/build.ts` `ENTRIES`:

```ts
const ENTRIES: Record<string, string> = {
  vaultArchiveStart: 'vault-archive-start',
  vaultArchivePoll: 'vault-archive-poll',
  rssPoll: 'rss-poll',
  rssEnrich: 'rss-enrich',
};
```

`data-pipeline/template.yaml` `Resources`:

```yaml
  RssEnrich:
    Type: AWS::Serverless::Function
    Properties:
      FunctionName: rss-enrich
      CodeUri: dist/rss-enrich/
      Handler: index.handler
```

- [ ] **Step 6: Add the schedule, Bedrock env vars and IAM**

In `data-pipeline/terraform/pipeline-compute/main.tf`, add to `lambda_configs`:

```hcl
    rss-enrich = {
      handler      = "rssEnrich.handler"
      schedule     = "rate(10 minutes)"
      description  = "Classify pending RSS items, fetch article content for selected ones, and embed them into pgvector"
      memory_heavy = false
      input        = jsonencode({})
    }
```

and to `lambda_env`:

```hcl
    # Bedrock is not offered in ap-southeast-3 — call it cross-region.
    BEDROCK_REGION              = var.bedrock_region
    BEDROCK_EMBEDDING_MODEL     = var.bedrock_embedding_model
    RSS_DAILY_CAP_PER_CATEGORY  = tostring(var.rss_daily_cap_per_category)
```

Add to `data-pipeline/terraform/pipeline-compute/variables.tf`:

```hcl
variable "bedrock_region" {
  description = "Region used for Bedrock calls. Bedrock is unavailable in ap-southeast-3."
  type        = string
  default     = "ap-southeast-1"
}

variable "bedrock_embedding_model" {
  description = "Bedrock embedding model id. Must produce 1024 dimensions to match rss.item_chunks."
  type        = string
  default     = "amazon.titan-embed-text-v2:0"
}

variable "rss_daily_cap_per_category" {
  description = "Maximum items selected per category per UTC day (5 categories x this = daily ceiling)."
  type        = number
  default     = 25
}
```

Append to `data-pipeline/terraform/pipeline-compute/iam.tf`:

```hcl
# Bedrock — embedding article chunks and search queries. Scoped to the single
# embedding model, in the cross-region Bedrock endpoint.
resource "aws_iam_policy" "bedrock_invoke" {
  name        = "${local.prefix}-bedrock-invoke"
  description = "Allow pipeline Lambdas to invoke the Bedrock embedding model"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "InvokeEmbeddingModel"
      Effect   = "Allow"
      Action   = ["bedrock:InvokeModel"]
      Resource = "arn:aws:bedrock:${var.bedrock_region}::foundation-model/${var.bedrock_embedding_model}"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "bedrock_invoke" {
  role       = aws_iam_role.pipeline_lambda.name
  policy_arn = aws_iam_policy.bedrock_invoke.arn
}
```

- [ ] **Step 7: Build, typecheck and validate**

```bash
pnpm --filter data-pipeline tsc
pnpm --filter data-pipeline build
cd data-pipeline/terraform/pipeline-compute && terraform fmt -check && terraform validate && cd -
```

Expected: tsc clean; build prints four functions including `rss-enrich`; `terraform validate` succeeds.

- [ ] **Step 8: Run the whole pipeline suite**

Run: `pnpm --filter data-pipeline test`
Expected: PASS — all pipeline tests, existing vault ones included.

- [ ] **Step 9: Commit**

```bash
git add data-pipeline/src/lambda/rssEnrich.ts data-pipeline/src/lambda/rssEnrich.test.ts \
        data-pipeline/scripts/build.ts data-pipeline/template.yaml \
        data-pipeline/terraform/pipeline-compute
git commit -m "feat(rss): add rss-enrich lambda for classification, content and embeddings"
```

- [ ] **Step 10: Deploy and verify in staging (manual)**

```bash
pnpm --filter data-pipeline build
cd data-pipeline/terraform/pipeline-compute && terraform apply && cd -
aws lambda invoke --function-name mna-staging-pipeline-rss-enrich --payload '{}' /tmp/rss-enrich.json
cat /tmp/rss-enrich.json
```

Expected: `classified` > 0 on the first run, `selected` at or under the per-category cap, `chunks_written` > 0.

Then confirm the vector index is populated and the cap is holding:

```sql
SELECT relevance, count(*) FROM rss.items GROUP BY 1;
SELECT category, count(*) FROM rss.items
  WHERE relevance = 'selected'
    AND classified_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
  GROUP BY 1;
SELECT count(*) FROM rss.item_chunks;
```

Expected: no category above 25 for the day; `rss.item_chunks` non-empty.

**Watch for:** an `AccessDeniedException` on Bedrock means the model has not been enabled in the account for `ap-southeast-1` — enable model access for Titan Embed Text v2 in the Bedrock console, which is a one-time account action Terraform cannot do.

---

**Phase 3 exit criteria:** selected items have `content_text` and chunks with embeddings; the daily cap holds at 25/category; classification, fetch and embedding failures each degrade gracefully (retry, fall back, or skip) without failing the run.

---

# Phase 4 — App API and Data Navigator page

### Task 16: `RssItemRepository` and `RssItemChunkRepository`

**Files:**
- Create: `src/lib/repositories/rssItemRepository.ts`
- Create: `src/lib/repositories/rssItemRepository.test.ts`
- Create: `src/lib/repositories/rssItemChunkRepository.ts`
- Create: `src/lib/repositories/rssItemChunkRepository.test.ts`
- Modify: `src/lib/repositories/index.ts`

**Interfaces:**
- Produces:
  - `class RssItemRepository { constructor(db: DbClient) }`
    - `listItems(filters: RssItemFilters): Promise<RssItemListRow[]>`
    - `findById(id: string): Promise<Tables<'rss_items'> | undefined>`
    - `findByIds(ids: string[]): Promise<RssItemListRow[]>`
    - `textSearch(query: string, filters: RssItemFilters, limit: number): Promise<RssItemListRow[]>`
    - `listFilterOptions(): Promise<{ category; source_name; region }[]>`
  - `interface RssItemFilters { categories?; sourceNames?; regions?; from?; to?; selectedOnly?; cursor?: RssItemCursor; limit?: number }`
  - `interface RssItemCursor { publishedAt: string | null; id: string }`
  - `type RssItemListRow` — the list projection, i.e. every column except `content_text` and `llm_labels`
  - `class RssItemChunkRepository { constructor(db: DbClient) }` with `vectorSearch(embedding: number[], topK: number, filters: RssItemFilters): Promise<VectorHit[]>`
  - `interface VectorHit { item_id: string; chunk_text: string; distance: number }`

- [ ] **Step 1: Write the failing item-repository test**

Create `src/lib/repositories/rssItemRepository.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RssItemRepository } from './rssItemRepository';

function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
  return chunks
    .map((c) => {
      if (typeof c === 'string' || typeof c === 'number') return String(c);
      if (c && typeof c === 'object' && 'value' in (c as object)) {
        const v = (c as { value: unknown }).value;
        return Array.isArray(v) ? v.join('') : String(v);
      }
      return '';
    })
    .join('');
}

const selectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
  groupBy: vi.fn().mockReturnThis(),
  limit: vi.fn(),
};

const mockDb = {
  select: vi.fn().mockReturnValue(selectChain),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
};

function resetDb() {
  vi.clearAllMocks();
  mockDb.select.mockReturnValue(selectChain);
  mockDb.execute.mockResolvedValue({ rows: [] });
  selectChain.from.mockReturnThis();
  selectChain.where.mockReturnThis();
  selectChain.orderBy.mockReturnThis();
  selectChain.groupBy.mockReturnThis();
}

describe('RssItemRepository.listItems', () => {
  let repo: RssItemRepository;

  beforeEach(() => {
    resetDb();
    repo = new RssItemRepository(mockDb as never);
  });

  it('returns rows ordered newest-first with a bounded page size', async () => {
    selectChain.limit.mockResolvedValueOnce([{ id: 'i1' }]);

    const rows = await repo.listItems({});

    expect(rows).toEqual([{ id: 'i1' }]);
    expect(selectChain.orderBy).toHaveBeenCalledTimes(1);
    expect(selectChain.limit).toHaveBeenCalledWith(50);
  });

  it('clamps an absurd page size instead of trusting the caller', async () => {
    selectChain.limit.mockResolvedValueOnce([]);
    await repo.listItems({ limit: 100000 });
    expect(selectChain.limit).toHaveBeenCalledWith(100);
  });

  it('returns [] without querying when a filter array is explicitly empty', async () => {
    expect(await repo.listItems({ categories: [] })).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('adds a WHERE clause for each supplied filter', async () => {
    selectChain.limit.mockResolvedValueOnce([]);

    await repo.listItems({
      categories: ['new_funding'],
      sourceNames: ['Mint'],
      regions: ['India'],
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-02T00:00:00Z',
      selectedOnly: true,
    });

    expect(selectChain.where).toHaveBeenCalledTimes(1);
  });

  it('applies keyset pagination when a cursor is given', async () => {
    selectChain.limit.mockResolvedValueOnce([]);

    await repo.listItems({ cursor: { publishedAt: '2026-09-01T00:00:00Z', id: 'i9' } });

    expect(selectChain.where).toHaveBeenCalledTimes(1);
  });

  it('never selects content_text in the list projection', async () => {
    selectChain.limit.mockResolvedValueOnce([]);
    await repo.listItems({});
    const projection = mockDb.select.mock.calls[0][0] as Record<string, unknown>;
    expect(projection).not.toHaveProperty('content_text');
    expect(projection).toHaveProperty('title');
  });
});

describe('RssItemRepository.findByIds', () => {
  let repo: RssItemRepository;

  beforeEach(() => {
    resetDb();
    repo = new RssItemRepository(mockDb as never);
  });

  it('returns [] without hitting the DB when the id list is empty', async () => {
    expect(await repo.findByIds([])).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('fetches every id in a single query', async () => {
    selectChain.where.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);

    const rows = await repo.findByIds(['a', 'b']);

    expect(rows).toHaveLength(2);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });
});

describe('RssItemRepository.textSearch', () => {
  let repo: RssItemRepository;

  beforeEach(() => {
    resetDb();
    repo = new RssItemRepository(mockDb as never);
  });

  it('matches title, authors and source_name', async () => {
    selectChain.limit.mockResolvedValueOnce([]);

    await repo.textSearch('acme', {}, 20);

    expect(selectChain.where).toHaveBeenCalledTimes(1);
    expect(selectChain.limit).toHaveBeenCalledWith(20);
  });

  it('returns [] for a blank query without querying', async () => {
    expect(await repo.textSearch('   ', {}, 20)).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

describe('RssItemRepository.listFilterOptions', () => {
  beforeEach(resetDb);

  it('returns the distinct facet combinations in one grouped query', async () => {
    mockDb.execute.mockResolvedValueOnce({
      rows: [{ category: 'new_funding', source_name: 'Mint', region: 'India' }],
    });
    const repo = new RssItemRepository(mockDb as never);

    const options = await repo.listFilterOptions();

    expect(options).toHaveLength(1);
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    expect(sqlText(mockDb.execute.mock.calls[0][0])).toContain('DISTINCT');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/lib/repositories/rssItemRepository.test.ts`
Expected: FAIL — cannot resolve `./rssItemRepository`.

- [ ] **Step 3: Write the item repository**

Create `src/lib/repositories/rssItemRepository.ts`:

```ts
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { rssItems } from '@/lib/db/schema';
import type { RssCategory } from '@/lib/db/schema';
import type { DbClient, Tables } from './types';

/** Keyset cursor. `publishedAt` may be null — undated items sort last. */
export interface RssItemCursor {
  publishedAt: string | null;
  id: string;
}

export interface RssItemFilters {
  categories?: RssCategory[];
  sourceNames?: string[];
  regions?: string[];
  /** ISO timestamps, inclusive. */
  from?: string;
  to?: string;
  /** Restrict to LLM-selected items (the curated ~75/day). */
  selectedOnly?: boolean;
  cursor?: RssItemCursor;
  limit?: number;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/**
 * The list projection: everything except `content_text` (potentially 200 KB
 * per row) and `llm_labels`. The detail endpoint fetches those for one row.
 */
const LIST_COLUMNS = {
  id: rssItems.id,
  category: rssItems.category,
  source_name: rssItems.source_name,
  region: rssItems.region,
  feed_tier: rssItems.feed_tier,
  title: rssItems.title,
  link: rssItems.link,
  summary: rssItems.summary,
  authors: rssItems.authors,
  tags: rssItems.tags,
  published_at: rssItems.published_at,
  ingested_at: rssItems.ingested_at,
  relevance: rssItems.relevance,
  relevance_score: rssItems.relevance_score,
  content_status: rssItems.content_status,
} as const;

export type RssItemListRow = {
  [K in keyof typeof LIST_COLUMNS]: Tables<'rss_items'>[K];
};

export interface RssItemFacet {
  category: string;
  source_name: string;
  region: string | null;
}

/** Read access to the global news lake. Not workspace-scoped by design. */
export class RssItemRepository {
  constructor(private readonly db: DbClient) {}

  async listItems(filters: RssItemFilters = {}): Promise<RssItemListRow[]> {
    const conditions = buildConditions(filters);
    if (conditions === null) return [];

    if (filters.cursor) {
      const { publishedAt, id } = filters.cursor;
      // Keyset, not OFFSET: pages stay correct while the poller inserts new
      // rows at the head of the list.
      conditions.push(
        publishedAt === null
          ? sql`(${rssItems.published_at} IS NULL AND ${rssItems.id} < ${id})`
          : sql`(${rssItems.published_at}, ${rssItems.id}) < (${publishedAt}::timestamptz, ${id}::uuid)`,
      );
    }

    const limit = clampLimit(filters.limit);
    const query = this.db.select(LIST_COLUMNS).from(rssItems);
    const filtered = conditions.length > 0 ? query.where(and(...conditions)) : query;

    return filtered
      .orderBy(sql`${rssItems.published_at} DESC NULLS LAST`, desc(rssItems.id))
      .limit(limit) as Promise<RssItemListRow[]>;
  }

  async findById(id: string): Promise<Tables<'rss_items'> | undefined> {
    const [row] = await this.db.select().from(rssItems).where(eq(rssItems.id, id)).limit(1);
    return row;
  }

  /**
   * Bulk hydrate list rows for a set of ids — used to turn vector-search hits
   * into displayable items without a query per hit.
   */
  async findByIds(ids: string[]): Promise<RssItemListRow[]> {
    if (ids.length === 0) return [];
    return this.db
      .select(LIST_COLUMNS)
      .from(rssItems)
      .where(inArray(rssItems.id, ids)) as Promise<RssItemListRow[]>;
  }

  /**
   * Lexical half of hybrid search: trigram-indexed ILIKE over the fields a
   * human types verbatim — headline words, an author, a publication.
   */
  async textSearch(
    query: string,
    filters: RssItemFilters = {},
    limit: number = 20,
  ): Promise<RssItemListRow[]> {
    const term = query.trim();
    if (term.length === 0) return [];

    const conditions = buildConditions(filters);
    if (conditions === null) return [];

    const pattern = `%${term}%`;
    conditions.push(
      or(
        ilike(rssItems.title, pattern),
        ilike(rssItems.authors, pattern),
        ilike(rssItems.source_name, pattern),
      )!,
    );

    return this.db
      .select(LIST_COLUMNS)
      .from(rssItems)
      .where(and(...conditions))
      .orderBy(sql`${rssItems.published_at} DESC NULLS LAST`, desc(rssItems.id))
      .limit(clampLimit(limit)) as Promise<RssItemListRow[]>;
  }

  /**
   * Distinct facet combinations for the filter bar, in one grouped query
   * rather than a query per category.
   */
  async listFilterOptions(): Promise<RssItemFacet[]> {
    const result = await this.db.execute(sql`
      SELECT DISTINCT category, source_name, region
      FROM rss.items
      ORDER BY category, source_name
    `);
    return queryRows<RssItemFacet>(result);
  }
}

/** Returns null when a filter is explicitly empty, meaning "matches nothing". */
function buildConditions(filters: RssItemFilters): ReturnType<typeof and>[] | null {
  const conditions: ReturnType<typeof and>[] = [];

  if (filters.categories !== undefined) {
    if (filters.categories.length === 0) return null;
    conditions.push(inArray(rssItems.category, filters.categories));
  }
  if (filters.sourceNames !== undefined) {
    if (filters.sourceNames.length === 0) return null;
    conditions.push(inArray(rssItems.source_name, filters.sourceNames));
  }
  if (filters.regions !== undefined) {
    if (filters.regions.length === 0) return null;
    conditions.push(inArray(rssItems.region, filters.regions));
  }
  if (filters.from) conditions.push(gte(rssItems.published_at, filters.from));
  if (filters.to) conditions.push(lte(rssItems.published_at, filters.to));
  if (filters.selectedOnly) conditions.push(eq(rssItems.relevance, 'selected'));

  return conditions;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

function queryRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}
```

- [ ] **Step 4: Run the item-repository tests**

Run: `pnpm vitest run src/lib/repositories/rssItemRepository.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 5: Write the failing chunk-repository test**

Create `src/lib/repositories/rssItemChunkRepository.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RssItemChunkRepository } from './rssItemChunkRepository';

function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
  return chunks
    .map((c) => {
      if (typeof c === 'string' || typeof c === 'number') return String(c);
      if (c && typeof c === 'object' && 'value' in (c as object)) {
        const v = (c as { value: unknown }).value;
        return Array.isArray(v) ? v.join('') : String(v);
      }
      return '';
    })
    .join('');
}

const mockDb = { execute: vi.fn() };
const embedding = Array.from({ length: 1024 }, () => 0.01);

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.execute.mockResolvedValue({ rows: [] });
});

describe('RssItemChunkRepository.vectorSearch', () => {
  it('orders by cosine distance and returns the hits', async () => {
    mockDb.execute.mockResolvedValueOnce({
      rows: [{ item_id: 'i1', chunk_text: 'Acme raised $40m', distance: 0.12 }],
    });
    const repo = new RssItemChunkRepository(mockDb as never);

    const hits = await repo.vectorSearch(embedding, 5, {});

    expect(hits).toEqual([{ item_id: 'i1', chunk_text: 'Acme raised $40m', distance: 0.12 }]);
    expect(sqlText(mockDb.execute.mock.calls[0][0])).toContain('<=>');
  });

  it('joins to items so category and date filters apply inside the same statement', async () => {
    const repo = new RssItemChunkRepository(mockDb as never);

    await repo.vectorSearch(embedding, 5, { categories: ['new_funding'], from: '2026-09-01T00:00:00Z' });

    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain('JOIN rss.items');
    expect(text).toContain('category');
    expect(text).toContain('published_at');
  });

  it('deduplicates to the best chunk per item so one article cannot fill the page', async () => {
    const repo = new RssItemChunkRepository(mockDb as never);
    await repo.vectorSearch(embedding, 5, {});
    expect(sqlText(mockDb.execute.mock.calls[0][0])).toContain('DISTINCT ON (c.item_id)');
  });

  it('rejects a vector of the wrong width rather than querying with it', async () => {
    const repo = new RssItemChunkRepository(mockDb as never);
    await expect(repo.vectorSearch([0.1, 0.2], 5, {})).rejects.toThrow(/1024/);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('returns [] without querying when a filter is explicitly empty', async () => {
    const repo = new RssItemChunkRepository(mockDb as never);
    expect(await repo.vectorSearch(embedding, 5, { categories: [] })).toEqual([]);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('clamps topK to a sane ceiling', async () => {
    const repo = new RssItemChunkRepository(mockDb as never);
    await repo.vectorSearch(embedding, 10_000, {});
    expect(sqlText(mockDb.execute.mock.calls[0][0])).toContain('50');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm vitest run src/lib/repositories/rssItemChunkRepository.test.ts`
Expected: FAIL — cannot resolve `./rssItemChunkRepository`.

- [ ] **Step 7: Write the chunk repository**

Create `src/lib/repositories/rssItemChunkRepository.ts`:

```ts
import { sql } from 'drizzle-orm';
import { EMBEDDING_DIMENSIONS } from '@/lib/bedrock';
import type { DbClient } from './types';
import type { RssItemFilters } from './rssItemRepository';

export interface VectorHit {
  item_id: string;
  chunk_text: string;
  distance: number;
}

const MAX_TOP_K = 50;

/**
 * Vector search over `rss.item_chunks`.
 *
 * Raw `sql` rather than the Drizzle query builder: pgvector's `<=>` operator
 * and `DISTINCT ON` have no builder expression. Every interpolated value is a
 * bound parameter — no string concatenation of user input.
 */
export class RssItemChunkRepository {
  constructor(private readonly db: DbClient) {}

  async vectorSearch(
    embedding: number[],
    topK: number,
    filters: RssItemFilters = {},
  ): Promise<VectorHit[]> {
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `vectorSearch expects ${EMBEDDING_DIMENSIONS} dimensions, got ${embedding.length}`,
      );
    }

    // An explicitly empty filter matches nothing.
    if (filters.categories?.length === 0) return [];
    if (filters.sourceNames?.length === 0) return [];
    if (filters.regions?.length === 0) return [];

    const limit = Math.min(MAX_TOP_K, Math.max(1, Math.floor(topK) || 1));
    // pgvector accepts the '[1,2,3]' text form for a vector literal.
    const vectorLiteral = `[${embedding.join(',')}]`;

    const result = await this.db.execute(sql`
      SELECT DISTINCT ON (c.item_id)
        c.item_id::text AS item_id,
        c.text          AS chunk_text,
        (c.embedding <=> ${vectorLiteral}::vector) AS distance
      FROM rss.item_chunks c
      JOIN rss.items i ON i.id = c.item_id
      WHERE TRUE
        ${filters.categories ? sql`AND i.category = ANY(${filters.categories})` : sql``}
        ${filters.sourceNames ? sql`AND i.source_name = ANY(${filters.sourceNames})` : sql``}
        ${filters.regions ? sql`AND i.region = ANY(${filters.regions})` : sql``}
        ${filters.from ? sql`AND i.published_at >= ${filters.from}::timestamptz` : sql``}
        ${filters.to ? sql`AND i.published_at <= ${filters.to}::timestamptz` : sql``}
      ORDER BY c.item_id, distance ASC
      LIMIT ${limit}
    `);

    const rows = queryRows<{ item_id: string; chunk_text: string; distance: number | string }>(
      result,
    );
    // DISTINCT ON must order by item_id first, so re-sort by relevance here.
    return rows
      .map((r) => ({ ...r, distance: Number(r.distance) }))
      .sort((a, b) => a.distance - b.distance);
  }
}

function queryRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}
```

- [ ] **Step 8: Export both from the barrel**

Append to `src/lib/repositories/index.ts`:

```ts
export * from './rssItemRepository';
export * from './rssItemChunkRepository';
```

- [ ] **Step 9: Run both test files**

Run: `pnpm vitest run src/lib/repositories/rssItemRepository.test.ts src/lib/repositories/rssItemChunkRepository.test.ts`
Expected: PASS — 17 tests total.

- [ ] **Step 10: Commit**

```bash
git add src/lib/repositories/rssItemRepository.ts src/lib/repositories/rssItemRepository.test.ts \
        src/lib/repositories/rssItemChunkRepository.ts src/lib/repositories/rssItemChunkRepository.test.ts \
        src/lib/repositories/index.ts
git commit -m "feat(rss): add item and chunk repositories with keyset paging and vector search"
```

---

### Task 17: `DataNavigatorService`

**Files:**
- Create: `src/lib/services/dataNavigatorService.ts`
- Create: `src/lib/services/dataNavigatorService.test.ts`
- Modify: `src/lib/services/container.ts`

**Interfaces:**
- Consumes: `RssItemRepository`, `RssItemChunkRepository`, `BedrockEmbeddingClient`.
- Produces:
  - `class DataNavigatorService { constructor(itemRepo, chunkRepo, embeddings) }`
  - `listItems(filters): Promise<{ items: RssItemListRow[]; nextCursor: RssItemCursor | null }>`
  - `getItem(id): Promise<Tables<'rss_items'>>` (throws `RssItemNotFoundError`)
  - `searchNews(query: string, opts?: SearchOptions): Promise<NewsSearchHit[]>`
  - `listFilterOptions(): Promise<FilterOptions>`
  - `interface NewsSearchHit { id; title; source_name; category; published_at; link; snippet; score; matchedBy: 'vector' | 'text' | 'both' }`
  - `interface FilterOptions { categories: string[]; sources: { name: string; category: string }[]; regions: string[] }`
  - Container key `dataNavigatorService`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/services/dataNavigatorService.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataNavigatorService, RssItemNotFoundError } from './dataNavigatorService';
import type { RssItemRepository, RssItemChunkRepository } from '@/lib/repositories';
import type { BedrockEmbeddingClient } from '@/lib/bedrock';

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    category: 'new_funding',
    source_name: 'Mint',
    region: 'India',
    feed_tier: 'curated',
    title: `Title ${id}`,
    link: `https://example.com/${id}`,
    summary: `Summary ${id}`,
    authors: null,
    tags: null,
    published_at: '2026-09-02T08:00:00.000Z',
    ingested_at: '2026-09-02T08:05:00.000Z',
    relevance: 'selected',
    relevance_score: 0.9,
    content_status: 'fetched',
    ...overrides,
  };
}

describe('DataNavigatorService', () => {
  let itemRepo: {
    listItems: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findByIds: ReturnType<typeof vi.fn>;
    textSearch: ReturnType<typeof vi.fn>;
    listFilterOptions: ReturnType<typeof vi.fn>;
  };
  let chunkRepo: { vectorSearch: ReturnType<typeof vi.fn> };
  let embeddings: { embed: ReturnType<typeof vi.fn> };
  let service: DataNavigatorService;

  beforeEach(() => {
    itemRepo = {
      listItems: vi.fn(),
      findById: vi.fn(),
      findByIds: vi.fn(),
      textSearch: vi.fn().mockResolvedValue([]),
      listFilterOptions: vi.fn(),
    };
    chunkRepo = { vectorSearch: vi.fn().mockResolvedValue([]) };
    embeddings = { embed: vi.fn().mockResolvedValue(Array.from({ length: 1024 }, () => 0.01)) };
    service = new DataNavigatorService(
      itemRepo as unknown as RssItemRepository,
      chunkRepo as unknown as RssItemChunkRepository,
      embeddings as unknown as BedrockEmbeddingClient,
    );
  });

  it('listItems returns a null cursor when the page is not full', async () => {
    itemRepo.listItems.mockResolvedValueOnce([row('a')]);

    const out = await service.listItems({ limit: 50 });

    expect(out.items).toHaveLength(1);
    expect(out.nextCursor).toBeNull();
  });

  it('listItems returns a cursor built from the last row when the page is full', async () => {
    itemRepo.listItems.mockResolvedValueOnce([row('a'), row('b')]);

    const out = await service.listItems({ limit: 2 });

    expect(out.nextCursor).toEqual({ publishedAt: '2026-09-02T08:00:00.000Z', id: 'b' });
  });

  it('getItem throws RssItemNotFoundError for an unknown id', async () => {
    itemRepo.findById.mockResolvedValueOnce(undefined);
    await expect(service.getItem('nope')).rejects.toBeInstanceOf(RssItemNotFoundError);
  });

  it('getItem returns the full row including content_text', async () => {
    itemRepo.findById.mockResolvedValueOnce({ ...row('a'), content_text: 'Body' });
    const item = await service.getItem('a');
    expect(item.content_text).toBe('Body');
  });

  it('searchNews embeds the query once and runs both search halves', async () => {
    chunkRepo.vectorSearch.mockResolvedValueOnce([
      { item_id: 'a', chunk_text: 'Acme raised money', distance: 0.2 },
    ]);
    itemRepo.findByIds.mockResolvedValueOnce([row('a')]);

    const hits = await service.searchNews('acme funding');

    expect(embeddings.embed).toHaveBeenCalledTimes(1);
    expect(itemRepo.textSearch).toHaveBeenCalledTimes(1);
    expect(hits).toHaveLength(1);
    expect(hits[0].matchedBy).toBe('vector');
    expect(hits[0].snippet).toBe('Acme raised money');
  });

  it('searchNews marks an item found by both halves and ranks it first', async () => {
    chunkRepo.vectorSearch.mockResolvedValueOnce([
      { item_id: 'a', chunk_text: 'chunk a', distance: 0.4 },
      { item_id: 'b', chunk_text: 'chunk b', distance: 0.3 },
    ]);
    itemRepo.textSearch.mockResolvedValueOnce([row('a')]);
    itemRepo.findByIds.mockResolvedValueOnce([row('a'), row('b')]);

    const hits = await service.searchNews('acme');

    expect(hits[0].id).toBe('a');
    expect(hits[0].matchedBy).toBe('both');
    expect(hits[1].matchedBy).toBe('vector');
  });

  it('searchNews still returns lexical hits when embedding fails', async () => {
    embeddings.embed.mockRejectedValueOnce(new Error('bedrock down'));
    itemRepo.textSearch.mockResolvedValueOnce([row('a')]);
    itemRepo.findByIds.mockResolvedValueOnce([row('a')]);

    const hits = await service.searchNews('acme');

    expect(hits).toHaveLength(1);
    expect(hits[0].matchedBy).toBe('text');
    expect(chunkRepo.vectorSearch).not.toHaveBeenCalled();
  });

  it('searchNews returns [] for a blank query without calling anything', async () => {
    expect(await service.searchNews('   ')).toEqual([]);
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(itemRepo.textSearch).not.toHaveBeenCalled();
  });

  it('searchNews hydrates every hit in one batched call, never per hit', async () => {
    chunkRepo.vectorSearch.mockResolvedValueOnce([
      { item_id: 'a', chunk_text: 'x', distance: 0.1 },
      { item_id: 'b', chunk_text: 'y', distance: 0.2 },
      { item_id: 'c', chunk_text: 'z', distance: 0.3 },
    ]);
    itemRepo.findByIds.mockResolvedValueOnce([row('a'), row('b'), row('c')]);

    await service.searchNews('acme');

    expect(itemRepo.findByIds).toHaveBeenCalledTimes(1);
    expect(itemRepo.findByIds).toHaveBeenCalledWith(expect.arrayContaining(['a', 'b', 'c']));
  });

  it('searchNews drops hits whose item row has since disappeared', async () => {
    chunkRepo.vectorSearch.mockResolvedValueOnce([
      { item_id: 'a', chunk_text: 'x', distance: 0.1 },
      { item_id: 'gone', chunk_text: 'y', distance: 0.2 },
    ]);
    itemRepo.findByIds.mockResolvedValueOnce([row('a')]);

    const hits = await service.searchNews('acme');

    expect(hits.map((h) => h.id)).toEqual(['a']);
  });

  it('searchNews honours topK after merging both halves', async () => {
    chunkRepo.vectorSearch.mockResolvedValueOnce([
      { item_id: 'a', chunk_text: 'x', distance: 0.1 },
      { item_id: 'b', chunk_text: 'y', distance: 0.2 },
    ]);
    itemRepo.findByIds.mockResolvedValueOnce([row('a'), row('b')]);

    const hits = await service.searchNews('acme', { topK: 1 });

    expect(hits).toHaveLength(1);
  });

  it('listFilterOptions groups sources under their category and dedupes regions', async () => {
    itemRepo.listFilterOptions.mockResolvedValueOnce([
      { category: 'new_funding', source_name: 'Mint', region: 'India' },
      { category: 'new_funding', source_name: 'DealStreetAsia', region: 'APAC' },
      { category: 'ma_partnerships', source_name: 'MarketBeat', region: 'India' },
    ]);

    const options = await service.listFilterOptions();

    expect(options.categories).toEqual(['ma_partnerships', 'new_funding']);
    expect(options.regions).toEqual(['APAC', 'India']);
    expect(options.sources).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/lib/services/dataNavigatorService.test.ts`
Expected: FAIL — cannot resolve `./dataNavigatorService`.

- [ ] **Step 3: Write the service**

Create `src/lib/services/dataNavigatorService.ts`:

```ts
import type { BedrockEmbeddingClient } from '@/lib/bedrock';
import type {
  RssItemChunkRepository,
  RssItemCursor,
  RssItemFilters,
  RssItemListRow,
  RssItemRepository,
  Tables,
} from '@/lib/repositories';

export class RssItemNotFoundError extends Error {
  constructor(id: string) {
    super(`News item ${id} not found`);
    this.name = 'RssItemNotFoundError';
  }
}

export interface SearchOptions {
  topK?: number;
  categories?: RssItemFilters['categories'];
  from?: string;
}

export interface NewsSearchHit {
  id: string;
  title: string;
  source_name: string;
  category: string;
  published_at: string | null;
  link: string;
  snippet: string;
  score: number;
  matchedBy: 'vector' | 'text' | 'both';
}

export interface FilterOptions {
  categories: string[];
  sources: { name: string; category: string }[];
  regions: string[];
}

export interface ItemPage {
  items: RssItemListRow[];
  nextCursor: RssItemCursor | null;
}

const DEFAULT_TOP_K = 8;
/** Fixed relevance credit for a lexical hit, so exact title/author matches
 *  always surface even when they are semantically distant from the query. */
const TEXT_MATCH_SCORE = 0.6;

export class DataNavigatorService {
  constructor(
    private readonly itemRepo: RssItemRepository,
    private readonly chunkRepo: RssItemChunkRepository,
    private readonly embeddings: BedrockEmbeddingClient,
  ) {}

  async listItems(filters: RssItemFilters = {}): Promise<ItemPage> {
    const items = await this.itemRepo.listItems(filters);
    const requested = filters.limit ?? 50;
    // A short page means we reached the end; only a full page can have more.
    const last = items.length === requested ? items[items.length - 1] : undefined;
    return {
      items,
      nextCursor: last ? { publishedAt: last.published_at, id: last.id } : null,
    };
  }

  async getItem(id: string): Promise<Tables<'rss_items'>> {
    const item = await this.itemRepo.findById(id);
    if (!item) throw new RssItemNotFoundError(id);
    return item;
  }

  /**
   * Hybrid search: semantic (pgvector) plus lexical (trigram ILIKE), merged.
   *
   * Both halves run because they fail differently — embeddings miss an exact
   * surname or ticker, ILIKE misses a paraphrase. An item found by both ranks
   * above one found by either. If Bedrock is unavailable the lexical half
   * still answers, so search degrades rather than breaks.
   */
  async searchNews(query: string, opts: SearchOptions = {}): Promise<NewsSearchHit[]> {
    const term = query.trim();
    if (term.length === 0) return [];

    const topK = opts.topK ?? DEFAULT_TOP_K;
    const filters: RssItemFilters = { categories: opts.categories, from: opts.from };

    const [vectorHits, textHits] = await Promise.all([
      this.vectorHalf(term, topK, filters),
      this.itemRepo.textSearch(term, filters, topK),
    ]);

    const scores = new Map<
      string,
      { score: number; snippet?: string; vector: boolean; text: boolean }
    >();

    for (const hit of vectorHits) {
      // Cosine distance 0..2 → similarity 0..1.
      const similarity = Math.max(0, 1 - hit.distance);
      scores.set(hit.item_id, {
        score: similarity,
        snippet: hit.chunk_text,
        vector: true,
        text: false,
      });
    }
    for (const item of textHits) {
      const existing = scores.get(item.id);
      if (existing) {
        existing.text = true;
        existing.score += TEXT_MATCH_SCORE;
      } else {
        scores.set(item.id, { score: TEXT_MATCH_SCORE, vector: false, text: true });
      }
    }

    if (scores.size === 0) return [];

    // One batched hydrate for every hit — never a lookup per hit.
    const rows = await this.itemRepo.findByIds([...scores.keys()]);
    const byId = new Map(rows.map((row) => [row.id, row]));

    return [...scores.entries()]
      .map(([id, entry]) => {
        const row = byId.get(id);
        if (!row) return null;
        return {
          id: row.id,
          title: row.title,
          source_name: row.source_name,
          category: row.category,
          published_at: row.published_at,
          link: row.link,
          snippet: (entry.snippet ?? row.summary ?? '').slice(0, 400),
          score: Number(entry.score.toFixed(4)),
          matchedBy: (entry.vector && entry.text
            ? 'both'
            : entry.vector
              ? 'vector'
              : 'text') as NewsSearchHit['matchedBy'],
        };
      })
      .filter((hit): hit is NewsSearchHit => hit !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  async listFilterOptions(): Promise<FilterOptions> {
    const facets = await this.itemRepo.listFilterOptions();
    const categories = new Set<string>();
    const regions = new Set<string>();
    const sources: { name: string; category: string }[] = [];

    for (const facet of facets) {
      categories.add(facet.category);
      if (facet.region) regions.add(facet.region);
      sources.push({ name: facet.source_name, category: facet.category });
    }

    return {
      categories: [...categories].sort(),
      sources,
      regions: [...regions].sort(),
    };
  }

  /** Vector half, isolated so a Bedrock outage can't take search down. */
  private async vectorHalf(
    term: string,
    topK: number,
    filters: RssItemFilters,
  ): Promise<{ item_id: string; chunk_text: string; distance: number }[]> {
    try {
      const embedding = await this.embeddings.embed(term);
      return await this.chunkRepo.vectorSearch(embedding, topK, filters);
    } catch (err) {
      console.error('[data-navigator] vector search unavailable:', err);
      return [];
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/services/dataNavigatorService.test.ts`
Expected: PASS — 13 tests.

- [ ] **Step 5: Wire into the container**

Four edits in `src/lib/services/container.ts`, mirroring Task 4:

1. Add `RssItemRepository,` and `RssItemChunkRepository,` to the `@/lib/repositories` import block.
2. Add the imports:

```ts
import { DataNavigatorService } from './dataNavigatorService';
import { BedrockEmbeddingClient } from '@/lib/bedrock';
```

3. Add to the `Container` interface, next to `rssFeedService`:

```ts
  dataNavigatorService: DataNavigatorService;
```

4. Add the wiring next to the `rssFeedRepo` lines from Task 4:

```ts
  const rssItemRepo = new RssItemRepository(db);
  const rssItemChunkRepo = new RssItemChunkRepository(db);
  const dataNavigatorService = new DataNavigatorService(
    rssItemRepo,
    rssItemChunkRepo,
    new BedrockEmbeddingClient(),
  );
```

and add `dataNavigatorService,` to the returned object.

- [ ] **Step 6: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/services/dataNavigatorService.ts src/lib/services/dataNavigatorService.test.ts \
        src/lib/services/container.ts
git commit -m "feat(rss): add DataNavigatorService with hybrid vector+lexical search"
```

---

### Task 18: API routes and client wrappers

**Files:**
- Create: `src/app/api/data-navigator/items/route.ts`
- Create: `src/app/api/data-navigator/items/[id]/route.ts`
- Create: `src/app/api/data-navigator/search/route.ts`
- Create: `src/app/api/data-navigator/filters/route.ts`
- Create: `src/lib/api/dataNavigator.ts`

**Interfaces:**
- Consumes: `dataNavigatorService` from Task 17.
- Produces client functions: `listNewsItems(params): Promise<ItemPage>`, `getNewsItem(id)`, `searchNews(query, params)`, `listNewsFilterOptions()`; plus the exported types `NewsItem`, `NewsItemDetail`, `NewsListParams`.

- [ ] **Step 1: Write the list route**

Create `src/app/api/data-navigator/items/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { RSS_CATEGORIES } from '@/lib/db/schema';
import type { RssCategory } from '@/lib/db/schema';

/**
 * The Data Navigator feed. Session-gated by the proxy middleware like every
 * other `/api/*` route; the underlying data is global, not workspace-scoped.
 */
export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;

    const cursorId = params.get('cursorId');
    const cursorPublishedAt = params.get('cursorPublishedAt');

    const db = createDb();
    const { dataNavigatorService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dataNavigatorService.listItems({
      categories: splitEnum<RssCategory>(params.get('category'), RSS_CATEGORIES),
      sourceNames: splitList(params.get('source')),
      regions: splitList(params.get('region')),
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      selectedOnly: params.get('selectedOnly') === 'true',
      limit: params.get('limit') ? Number(params.get('limit')) : undefined,
      cursor: cursorId ? { id: cursorId, publishedAt: cursorPublishedAt } : undefined,
    });

    return NextResponse.json({ data });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to fetch news items' }, { status: 500 });
  }
}

function splitList(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const values = raw.split(',').map((v) => v.trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function splitEnum<T extends string>(
  raw: string | null,
  allowed: readonly string[],
): T[] | undefined {
  const values = splitList(raw);
  if (!values) return undefined;
  const filtered = values.filter((v) => allowed.includes(v)) as T[];
  // All-invalid input must not silently widen to "everything".
  return filtered.length > 0 ? filtered : ([] as T[]);
}
```

- [ ] **Step 2: Write the detail route**

Create `src/app/api/data-navigator/items/[id]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { RssItemNotFoundError } from '@/lib/services/dataNavigatorService';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const db = createDb();
    const { dataNavigatorService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dataNavigatorService.getItem(id);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof RssItemNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error(error);
    return NextResponse.json({ error: 'Failed to fetch news item' }, { status: 500 });
  }
}
```

- [ ] **Step 3: Write the search and filters routes**

Create `src/app/api/data-navigator/search/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { RSS_CATEGORIES } from '@/lib/db/schema';
import type { RssCategory } from '@/lib/db/schema';

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const query = params.get('q')?.trim();
    if (!query) {
      return NextResponse.json({ error: 'q is required' }, { status: 400 });
    }

    const categoryParam = params.get('category');
    const categories = categoryParam
      ? (categoryParam
          .split(',')
          .map((c) => c.trim())
          .filter((c) => (RSS_CATEGORIES as readonly string[]).includes(c)) as RssCategory[])
      : undefined;

    const db = createDb();
    const { dataNavigatorService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dataNavigatorService.searchNews(query, {
      topK: params.get('topK') ? Number(params.get('topK')) : undefined,
      categories,
      from: params.get('from') ?? undefined,
    });

    return NextResponse.json({ data });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}
```

Create `src/app/api/data-navigator/filters/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

export async function GET() {
  try {
    const db = createDb();
    const { dataNavigatorService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dataNavigatorService.listFilterOptions();
    return NextResponse.json({ data });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to fetch filter options' }, { status: 500 });
  }
}
```

- [ ] **Step 4: Write the client wrapper**

Create `src/lib/api/dataNavigator.ts`:

```ts
import { apiRequest } from '@/lib/api/client';
import type { Tables } from '@/lib/repositories';
import type {
  FilterOptions,
  ItemPage,
  NewsSearchHit,
} from '@/lib/services/dataNavigatorService';

export type NewsItem = ItemPage['items'][number];
export type NewsItemDetail = Tables<'rss_items'>;
export type { FilterOptions, NewsSearchHit };

export interface NewsListParams {
  categories?: string[];
  sources?: string[];
  regions?: string[];
  from?: string;
  to?: string;
  selectedOnly?: boolean;
  limit?: number;
  cursor?: { publishedAt: string | null; id: string } | null;
}

export function listNewsItems(params: NewsListParams = {}): Promise<ItemPage> {
  const search = new URLSearchParams();
  if (params.categories?.length) search.set('category', params.categories.join(','));
  if (params.sources?.length) search.set('source', params.sources.join(','));
  if (params.regions?.length) search.set('region', params.regions.join(','));
  if (params.from) search.set('from', params.from);
  if (params.to) search.set('to', params.to);
  if (params.selectedOnly) search.set('selectedOnly', 'true');
  if (params.limit) search.set('limit', String(params.limit));
  if (params.cursor) {
    search.set('cursorId', params.cursor.id);
    if (params.cursor.publishedAt) search.set('cursorPublishedAt', params.cursor.publishedAt);
  }

  const qs = search.toString();
  return apiRequest<ItemPage>(`/api/data-navigator/items${qs ? `?${qs}` : ''}`);
}

export function getNewsItem(id: string): Promise<NewsItemDetail> {
  return apiRequest<NewsItemDetail>(`/api/data-navigator/items/${id}`);
}

export function searchNews(
  query: string,
  params: { topK?: number; categories?: string[]; from?: string } = {},
): Promise<NewsSearchHit[]> {
  const search = new URLSearchParams({ q: query });
  if (params.topK) search.set('topK', String(params.topK));
  if (params.categories?.length) search.set('category', params.categories.join(','));
  if (params.from) search.set('from', params.from);
  return apiRequest<NewsSearchHit[]>(`/api/data-navigator/search?${search.toString()}`);
}

export function listNewsFilterOptions(): Promise<FilterOptions> {
  return apiRequest<FilterOptions>('/api/data-navigator/filters');
}
```

- [ ] **Step 5: Typecheck and verify the endpoints by hand**

Run: `pnpm tsc --noEmit`
Expected: exits 0.

With `vercel dev` running and the seed data from Task 5 in place:

```bash
curl -s 'http://localhost:3000/api/data-navigator/items?limit=3' -H "X-Api-Secret: $ADMIN_SECRET" | head -c 400
curl -s 'http://localhost:3000/api/data-navigator/filters' -H "X-Api-Secret: $ADMIN_SECRET" | head -c 300
curl -s 'http://localhost:3000/api/data-navigator/search?q=sample' -H "X-Api-Secret: $ADMIN_SECRET" | head -c 300
```

Expected: the list returns `{"data":{"items":[…],"nextCursor":…}}`; filters returns categories/sources/regions; search returns an array (lexical hits at minimum — the vector half returns nothing locally until embeddings exist, which is the designed fallback).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/data-navigator src/lib/api/dataNavigator.ts
git commit -m "feat(rss): add data navigator API routes and client wrappers"
```

---

### Task 19: Feature flag and navigation entry

**Files:**
- Modify: `src/lib/features/catalog.ts`
- Modify: `src/lib/navigation/consoleTabs.ts`
- Modify: `src/lib/navigation/consoleTabs.test.ts`

**Interfaces:**
- Produces: feature key `DATA_NAVIGATOR_ENABLED`; console tab slug `data-navigator` at path `/data-navigator` in the `intelligence` group.

- [ ] **Step 1: Add the failing navigation test**

Append to `src/lib/navigation/consoleTabs.test.ts`:

```ts
describe('Data Navigator tab', () => {
  it('is registered in the intelligence group behind its own flag', () => {
    const tab = CONSOLE_TABS.find((t) => t.slug === 'data-navigator');
    expect(tab).toBeDefined();
    expect(tab?.path).toBe('/data-navigator');
    expect(tab?.group).toBe('intelligence');
    expect(tab?.flag).toBe('DATA_NAVIGATOR_ENABLED');
  });

  it('is hidden when the flag is off', () => {
    const visible = visibleConsoleTabs({ DATA_NAVIGATOR_ENABLED: false });
    expect(visible.some((t) => t.slug === 'data-navigator')).toBe(false);
  });

  it('is visible when the flag is on', () => {
    const visible = visibleConsoleTabs({ DATA_NAVIGATOR_ENABLED: true });
    expect(visible.some((t) => t.slug === 'data-navigator')).toBe(true);
  });
});
```

Make sure `CONSOLE_TABS` and `visibleConsoleTabs` are both in that file's import list.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/lib/navigation/consoleTabs.test.ts`
Expected: FAIL — `expect(tab).toBeDefined()` receives undefined.

- [ ] **Step 3: Register the feature**

In `src/lib/features/catalog.ts`, add to `FEATURE_CATALOG` alongside the other navigation features:

```ts
  {
    key: 'DATA_NAVIGATOR_ENABLED',
    label: 'Data Navigator',
    description:
      'Curated news feed built from global RSS sources, with full-article preview and semantic search.',
    defaultEnabled: false,
    navItem: true,
  },
```

Note `defaultEnabled: false` — unlike the established nav features, this one is new and ships dark until the pipeline is populated.

- [ ] **Step 4: Register the tab**

In `src/lib/navigation/consoleTabs.ts`, add to `CONSOLE_TABS` after the `smart-files` entry:

```ts
  {
    slug: 'data-navigator',
    path: '/data-navigator',
    label: 'Data Navigator',
    group: 'intelligence',
    flag: 'DATA_NAVIGATOR_ENABLED',
    purpose:
      'Recent market news from curated RSS sources — funding, M&A, market assessments and research, filterable and searchable.',
  },
```

- [ ] **Step 5: Run the navigation tests**

Run: `pnpm vitest run src/lib/navigation/consoleTabs.test.ts src/lib/features`
Expected: PASS — including any existing catalog/tab consistency test that asserts every tab flag exists in the catalog.

- [ ] **Step 6: Commit**

```bash
git add src/lib/features/catalog.ts src/lib/navigation/consoleTabs.ts src/lib/navigation/consoleTabs.test.ts
git commit -m "feat(rss): register the Data Navigator nav entry behind DATA_NAVIGATOR_ENABLED"
```

---

### Task 20: Data Navigator page

**Files:**
- Create: `src/app/w/[workspaceSlug]/data-navigator/page.tsx`
- Create: `src/app/data-navigator/page.tsx`
- Create: `src/views/DataNavigator.tsx`
- Create: `src/views/dataNavigator/NewsList.tsx`
- Create: `src/views/dataNavigator/NewsPreview.tsx`
- Create: `src/views/dataNavigator/FilterBar.tsx`

**Interfaces:**
- Consumes: `src/lib/api/dataNavigator.ts` from Task 18.
- Produces: the `/data-navigator` route; a master–detail view.

Split across four files rather than one: `DataNavigator.tsx` owns data fetching and selection state, the three children are presentational. This keeps each file small enough to reason about and matches how `src/views/fundManagement/*` is organised.

- [ ] **Step 1: Create the workspace-scoped page**

Create `src/app/w/[workspaceSlug]/data-navigator/page.tsx`:

```tsx
import DataNavigator from '@/views/DataNavigator';

export default async function DataNavigatorPage() {
  return <DataNavigator />;
}
```

- [ ] **Step 2: Create the legacy redirect page**

Create `src/app/data-navigator/page.tsx`:

```tsx
import { redirectToWorkspaceScoped } from '@/lib/legacyWorkspaceRedirect';

/** Pre-migration deeplink bridge — see `redirectToWorkspaceScoped`. */
export default async function LegacyDataNavigatorRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await redirectToWorkspaceScoped('/data-navigator', await searchParams);
}
```

- [ ] **Step 3: Create the filter bar**

Create `src/views/dataNavigator/FilterBar.tsx`:

```tsx
'use client';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { Search, X } from 'lucide-react';
import type { FilterOptions } from '@/lib/api/dataNavigator';

const CATEGORY_LABELS: Record<string, string> = {
  expert_insights: 'Expert Insights',
  market_assessment: 'Market Assessment',
  new_funding: 'New Funding',
  ma_partnerships: 'M&A / Partnerships',
  industry_reports: 'Industry Reports',
};

export interface FilterState {
  categories: string[];
  regions: string[];
  query: string;
  selectedOnly: boolean;
}

interface FilterBarProps {
  options: FilterOptions | null;
  value: FilterState;
  onChange: (next: FilterState) => void;
}

export function FilterBar({ options, value, onChange }: FilterBarProps) {
  const categories = options?.categories ?? Object.keys(CATEGORY_LABELS);

  function toggleCategory(category: string) {
    const next = value.categories.includes(category)
      ? value.categories.filter((c) => c !== category)
      : [...value.categories, category];
    onChange({ ...value, categories: next });
  }

  const hasFilters =
    value.categories.length > 0 || value.regions.length > 0 || value.query.length > 0;

  return (
    <div className="space-y-3 border-b p-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={value.query}
          onChange={(e) => onChange({ ...value, query: e.target.value })}
          placeholder="Search headlines, authors, or ask a question…"
          className="pl-8"
          aria-label="Search news"
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {categories.map((category) => {
          const active = value.categories.includes(category);
          return (
            <button
              key={category}
              type="button"
              onClick={() => toggleCategory(category)}
              aria-pressed={active}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs transition-colors',
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background hover:bg-muted',
              )}
            >
              {CATEGORY_LABELS[category] ?? category}
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Switch
            id="curated-only"
            checked={value.selectedOnly}
            onCheckedChange={(checked) => onChange({ ...value, selectedOnly: checked })}
          />
          <Label htmlFor="curated-only" className="text-xs text-muted-foreground">
            Curated picks only
          </Label>
        </div>

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              onChange({ categories: [], regions: [], query: '', selectedOnly: value.selectedOnly })
            }
          >
            <X className="mr-1 h-3 w-3" />
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

export { CATEGORY_LABELS };
```

- [ ] **Step 4: Create the list**

Create `src/views/dataNavigator/NewsList.tsx`:

```tsx
'use client';

import { useEffect, useRef } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import { CATEGORY_LABELS } from './FilterBar';
import type { NewsItem } from '@/lib/api/dataNavigator';

interface NewsListProps {
  items: NewsItem[];
  selectedId: string | null;
  loading: boolean;
  hasMore: boolean;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
}

export function NewsList({
  items,
  selectedId,
  loading,
  hasMore,
  onSelect,
  onLoadMore,
}: NewsListProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || loading) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMore();
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore]);

  if (!loading && items.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        No news matches these filters.
      </div>
    );
  }

  return (
    <div role="listbox" aria-label="News items" className="divide-y">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={item.id === selectedId}
          onClick={() => onSelect(item.id)}
          className={cn(
            'w-full px-4 py-3 text-left transition-colors hover:bg-muted/60',
            item.id === selectedId && 'bg-muted',
          )}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-xs font-medium text-muted-foreground">
              {item.source_name}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {item.published_at
                ? formatDistanceToNow(new Date(item.published_at), { addSuffix: true })
                : 'undated'}
            </span>
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm font-medium">{item.title}</div>
          {item.summary && (
            <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">{item.summary}</div>
          )}
          <div className="mt-1.5 flex items-center gap-1.5">
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {CATEGORY_LABELS[item.category] ?? item.category}
            </span>
            {item.relevance === 'selected' && (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                Curated
              </span>
            )}
          </div>
        </button>
      ))}

      <div ref={sentinelRef} className="h-8" />
      {loading && (
        <div className="p-4 text-center text-xs text-muted-foreground">Loading…</div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Create the preview pane**

Create `src/views/dataNavigator/NewsPreview.tsx`:

```tsx
'use client';

import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { ExternalLink, Newspaper } from 'lucide-react';
import { CATEGORY_LABELS } from './FilterBar';
import type { NewsItemDetail } from '@/lib/api/dataNavigator';

interface NewsPreviewProps {
  item: NewsItemDetail | null;
  loading: boolean;
}

export function NewsPreview({ item, loading }: NewsPreviewProps) {
  if (loading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading article…</div>;
  }

  if (!item) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
        <Newspaper className="h-8 w-8" />
        <p className="text-sm">Select an item to read it here.</p>
      </div>
    );
  }

  return (
    <article className="mx-auto max-w-3xl space-y-4 p-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded bg-muted px-1.5 py-0.5 uppercase tracking-wide">
            {CATEGORY_LABELS[item.category] ?? item.category}
          </span>
          <span>{item.source_name}</span>
          {item.region && <span>· {item.region}</span>}
          {item.published_at && (
            <span>· {format(new Date(item.published_at), 'd MMM yyyy, HH:mm')}</span>
          )}
        </div>

        <h1 className="text-xl font-semibold leading-tight">{item.title}</h1>

        {item.authors && <p className="text-sm text-muted-foreground">By {item.authors}</p>}

        <Button asChild variant="outline" size="sm">
          <a href={item.link} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            Read original
          </a>
        </Button>
      </header>

      {item.content_text ? (
        // Extracted plain text — render paragraphs, never dangerouslySetInnerHTML.
        <div className="space-y-3 text-sm leading-relaxed">
          {item.content_text
            .split(/\n{2,}/)
            .filter((p) => p.trim().length > 0)
            .map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm leading-relaxed">{item.summary ?? 'No preview available.'}</p>
          <p className="text-xs text-muted-foreground">
            {item.content_status === 'failed'
              ? 'The full article could not be retrieved from the publisher — use “Read original” above.'
              : 'The full article has not been fetched for this item.'}
          </p>
        </div>
      )}
    </article>
  );
}
```

- [ ] **Step 6: Create the container view**

Create `src/views/DataNavigator.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as newsApi from '@/lib/api/dataNavigator';
import type { FilterOptions, NewsItem, NewsItemDetail } from '@/lib/api/dataNavigator';
import { FilterBar, type FilterState } from './dataNavigator/FilterBar';
import { NewsList } from './dataNavigator/NewsList';
import { NewsPreview } from './dataNavigator/NewsPreview';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

export default function DataNavigator() {
  const [filters, setFilters] = useState<FilterState>({
    categories: [],
    regions: [],
    query: '',
    selectedOnly: false,
  });
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [items, setItems] = useState<NewsItem[]>([]);
  const [cursor, setCursor] = useState<{ publishedAt: string | null; id: string } | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Search hits the network on every keystroke otherwise.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(filters.query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filters.query]);

  const { data: options } = useQuery<FilterOptions>({
    queryKey: ['data-navigator', 'filters'],
    queryFn: newsApi.listNewsFilterOptions,
    staleTime: 5 * 60 * 1000,
  });

  const listParams = useMemo(
    () => ({
      categories: filters.categories.length > 0 ? filters.categories : undefined,
      regions: filters.regions.length > 0 ? filters.regions : undefined,
      selectedOnly: filters.selectedOnly,
      limit: PAGE_SIZE,
    }),
    [filters.categories, filters.regions, filters.selectedOnly],
  );

  const loadFirstPage = useCallback(async () => {
    setListLoading(true);
    try {
      if (debouncedQuery.length > 0) {
        // Search replaces the feed: hybrid results are ranked by relevance,
        // not recency, and are not paginated.
        const hits = await newsApi.searchNews(debouncedQuery, {
          topK: 30,
          categories: filters.categories.length > 0 ? filters.categories : undefined,
        });
        const asItems = hits.map(
          (hit) =>
            ({
              id: hit.id,
              category: hit.category,
              source_name: hit.source_name,
              region: null,
              feed_tier: 'curated',
              title: hit.title,
              link: hit.link,
              summary: hit.snippet,
              authors: null,
              tags: null,
              published_at: hit.published_at,
              ingested_at: hit.published_at,
              relevance: 'selected',
              relevance_score: hit.score,
              content_status: 'fetched',
            }) as unknown as NewsItem,
        );
        setItems(asItems);
        setCursor(null);
        setHasMore(false);
        setSelectedId(asItems[0]?.id ?? null);
        return;
      }

      const page = await newsApi.listNewsItems(listParams);
      setItems(page.items);
      setCursor(page.nextCursor);
      setHasMore(page.nextCursor !== null);
      setSelectedId(page.items[0]?.id ?? null);
    } finally {
      setListLoading(false);
    }
  }, [debouncedQuery, filters.categories, listParams]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!cursor || listLoading) return;
    setListLoading(true);
    try {
      const page = await newsApi.listNewsItems({ ...listParams, cursor });
      setItems((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
      setHasMore(page.nextCursor !== null);
    } finally {
      setListLoading(false);
    }
  }, [cursor, listLoading, listParams]);

  const { data: selectedItem, isLoading: previewLoading } = useQuery<NewsItemDetail | null>({
    queryKey: ['data-navigator', 'item', selectedId],
    queryFn: () => (selectedId ? newsApi.getNewsItem(selectedId) : Promise.resolve(null)),
    enabled: selectedId !== null,
  });

  // Arrow keys move through the list without leaving the reading pane.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;

      const index = items.findIndex((item) => item.id === selectedId);
      if (index === -1) return;
      const nextIndex = event.key === 'ArrowDown' ? index + 1 : index - 1;
      const next = items[nextIndex];
      if (!next) return;
      event.preventDefault();
      setSelectedId(next.id);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [items, selectedId]);

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[380px] shrink-0 flex-col border-r">
        <FilterBar options={options ?? null} value={filters} onChange={setFilters} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <NewsList
            items={items}
            selectedId={selectedId}
            loading={listLoading}
            hasMore={hasMore}
            onSelect={setSelectedId}
            onLoadMore={loadMore}
          />
        </div>
      </aside>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <NewsPreview item={selectedItem ?? null} loading={previewLoading && selectedId !== null} />
      </main>
    </div>
  );
}
```

- [ ] **Step 7: Verify it renders**

Run: `pnpm tsc --noEmit`
Expected: exits 0.

Then, with `DATA_NAVIGATOR_ENABLED=true` in `.env.local` and `vercel dev` running, open `http://localhost:3000/w/<slug>/data-navigator`.

Check by hand:
1. The sidebar shows "Data Navigator" under Intelligence.
2. The left pane lists seeded items newest-first; the right pane shows the first item's body.
3. Clicking another item swaps the preview; ↑/↓ moves the selection.
4. A category chip narrows the list; "Clear" restores it.
5. Typing in the search box replaces the list with ranked matches.
6. An item with `content_status = 'none'` shows the summary plus the "not been fetched" note and a working "Read original" link.

Set `DATA_NAVIGATOR_ENABLED=false` and reload: the nav entry disappears.

- [ ] **Step 8: Commit**

```bash
git add src/app/w/\[workspaceSlug\]/data-navigator src/app/data-navigator \
        src/views/DataNavigator.tsx src/views/dataNavigator
git commit -m "feat(rss): add the Data Navigator master-detail page"
```

---

**Phase 4 exit criteria:** `/data-navigator` renders behind its flag with a filterable newest-first list, a full-content preview, keyboard navigation, and hybrid search; every backend addition has unit tests; `pnpm tsc --noEmit` and `pnpm test` are clean.

---

# Phase 5 — RAG agent tool

### Task 21: `search_news` agent tool

**Files:**
- Create: `src/lib/agents/analysis/tools/search_news.ts`
- Create: `src/lib/agents/analysis/tools/search_news.test.ts`
- Modify: `src/lib/agents/analysis/tools/index.ts`

**Interfaces:**
- Consumes: `DataNavigatorService.searchNews` from Task 17.
- Produces: `export const searchNews` — a LangChain `tool` named `search_news` taking `{ query, categories?, publishedAfter?, topK? }` and returning a markdown string.

This folder's established conventions (verified against `lookup_user.ts`), which the code below follows:
- File name is snake_case (`search_news.ts`), the exported const is camelCase (`searchNews`).
- `import { tool } from '@langchain/core/tools'`, `import { z } from 'zod'`, `import { logger } from '../../logger'`.
- Tools log a `🔧 TOOL CALLED: …` debug line on entry.
- Tools construct their dependencies directly from `createDb()` rather than going through `createContainer` — the agent has no workspace context to pass, and the RSS repositories are global anyway.
- Errors are returned as `**Error:** <message>` strings, never thrown.
- `index.ts` requires three edits: the `import`, the `export { … }` block, and the `toolInfo` array used to describe the toolset to the model.

- [ ] **Step 1: Write the failing test**

Create `src/lib/agents/analysis/tools/search_news.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(() => ({})),
  searchNewsImpl: vi.fn(),
  embed: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: mocks.createDb }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/lib/repositories', () => ({
  RssItemRepository: class {},
  RssItemChunkRepository: class {},
}));
vi.mock('@/lib/bedrock', () => ({
  BedrockEmbeddingClient: class {
    embed = mocks.embed;
  },
}));
vi.mock('@/lib/services/dataNavigatorService', () => ({
  DataNavigatorService: class {
    searchNews = mocks.searchNewsImpl;
  },
}));

import { searchNews } from './search_news';

function hit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'i1',
    title: 'Acme raises $40m Series B',
    source_name: 'DealStreetAsia',
    category: 'new_funding',
    published_at: '2026-09-02T08:00:00.000Z',
    link: 'https://example.com/acme',
    snippet: 'Acme Corp closed a $40m round led by Beta Ventures.',
    score: 0.91,
    matchedBy: 'both',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('search_news tool', () => {
  it('returns a markdown list of hits with source, date and link', async () => {
    mocks.searchNewsImpl.mockResolvedValueOnce([hit()]);

    const out = (await searchNews.invoke({ query: 'acme funding' })) as string;

    expect(out).toContain('Acme raises $40m Series B');
    expect(out).toContain('DealStreetAsia');
    expect(out).toContain('2026-09-02');
    expect(out).toContain('https://example.com/acme');
  });

  it('passes category and date filters through to the service', async () => {
    mocks.searchNewsImpl.mockResolvedValueOnce([]);

    await searchNews.invoke({
      query: 'semiconductor M&A',
      categories: ['ma_partnerships'],
      publishedAfter: '2026-08-01',
      topK: 5,
    });

    expect(mocks.searchNewsImpl).toHaveBeenCalledWith('semiconductor M&A', {
      topK: 5,
      categories: ['ma_partnerships'],
      from: '2026-08-01',
    });
  });

  it('rejects a blank query before touching the database', async () => {
    const out = (await searchNews.invoke({ query: '   ' })) as string;
    expect(out).toContain('**Error:**');
    expect(mocks.searchNewsImpl).not.toHaveBeenCalled();
  });

  it('tells the agent plainly when nothing matched', async () => {
    mocks.searchNewsImpl.mockResolvedValueOnce([]);
    const out = (await searchNews.invoke({ query: 'nothing' })) as string;
    expect(out).toMatch(/no .*news/i);
  });

  it('returns an error string rather than throwing when the search fails', async () => {
    mocks.searchNewsImpl.mockRejectedValueOnce(new Error('bedrock down'));
    const out = (await searchNews.invoke({ query: 'acme' })) as string;
    expect(out).toContain('**Error:**');
    expect(out).toContain('bedrock down');
  });

  it('handles an undated item without rendering "Invalid Date"', async () => {
    mocks.searchNewsImpl.mockResolvedValueOnce([hit({ published_at: null })]);
    const out = (await searchNews.invoke({ query: 'acme' })) as string;
    expect(out).not.toContain('Invalid Date');
    expect(out).toContain('undated');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/lib/agents/analysis/tools/search_news.test.ts`
Expected: FAIL — cannot resolve `./search_news`.

- [ ] **Step 3: Write the tool**

Create `src/lib/agents/analysis/tools/search_news.ts`:

```ts
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { logger } from '../../logger';
import { createDb } from '@/lib/server/db';
import { RssItemRepository, RssItemChunkRepository } from '@/lib/repositories';
import { BedrockEmbeddingClient } from '@/lib/bedrock';
import { DataNavigatorService } from '@/lib/services/dataNavigatorService';
import { RSS_CATEGORIES } from '@/lib/db/schema';

/**
 * search_news — hybrid semantic + keyword search over the ingested news lake.
 *
 * Lets the agent answer "what has happened recently with X" from indexed
 * articles rather than from its training data. The lake is global (not
 * workspace-scoped), so the service is built straight from `createDb()`
 * instead of going through `createContainer`.
 */
const MAX_SNIPPET = 300;

export const searchNews = tool(
  async ({
    query,
    categories,
    publishedAfter,
    topK,
  }: {
    query: string;
    categories?: string[];
    publishedAfter?: string;
    topK?: number;
  }) => {
    logger.debug(`🔧 TOOL CALLED: search_news(query='${query ?? ''}')`);

    const term = query?.trim();
    if (!term) {
      return '**Error:** query is required (what to search the news lake for).';
    }

    try {
      const db = createDb();
      const service = new DataNavigatorService(
        new RssItemRepository(db),
        new RssItemChunkRepository(db),
        new BedrockEmbeddingClient(),
      );

      const hits = await service.searchNews(term, {
        topK: topK ?? 8,
        categories: categories as never,
        from: publishedAfter,
      });

      if (hits.length === 0) {
        return `No indexed news matched "${term}". The lake only holds items ingested from the configured RSS sources — try broader wording, an earlier \`publishedAfter\`, or no category filter.`;
      }

      const lines = hits.map((hit, index) => {
        const date = hit.published_at ? hit.published_at.slice(0, 10) : 'undated';
        const snippet = hit.snippet.replace(/\s+/g, ' ').slice(0, MAX_SNIPPET);
        return [
          `${index + 1}. **${hit.title}**`,
          `   ${hit.source_name} · ${hit.category} · ${date}`,
          `   ${snippet}`,
          `   ${hit.link}`,
        ].join('\n');
      });

      return `**Indexed news matching "${term}" (${hits.length}):**\n\n${lines.join('\n\n')}`;
    } catch (error) {
      // Tools must return text — a thrown error aborts the whole agent turn.
      const message = (error as Error).message;
      logger.error(`search_news failed: ${message}`);
      return `**Error:** ${message}`;
    }
  },
  {
    name: 'search_news',
    description:
      'Search the ingested market-news lake (funding rounds, M&A and partnerships, market assessments, expert insights, industry/analyst reports) by meaning and by keyword. Use it for recent real-world events about specific companies, sectors or deals.',
    schema: z.object({
      query: z.string().describe('What to look for, in natural language.'),
      categories: z
        .array(z.enum(RSS_CATEGORIES))
        .optional()
        .describe('Restrict the search to these news categories.'),
      publishedAfter: z
        .string()
        .optional()
        .describe('ISO date (YYYY-MM-DD); only return items published on or after it.'),
      topK: z.number().int().min(1).max(20).optional().describe('How many results (default 8).'),
    }),
  },
);
```

- [ ] **Step 4: Register the tool in three places**

In `src/lib/agents/analysis/tools/index.ts`:

1. Add the import beside the others:

```ts
import { searchNews } from "./search_news";
```

2. Add `searchNews,` to the `export { … }` block.

3. Add an entry to the `toolInfo` array (the list that describes the toolset to the model), after the `read_page_context` entry:

```ts
    {
      name: "search_news",
      description:
        "Search the ingested market-news lake (funding, M&A, market assessments, expert insights, industry reports) for recent real-world events about a company, sector or deal",
    },
```

Confirm the tool is also reaching the agent: check whether `../index.ts` builds its `tools` array from this module's exports automatically or lists each tool by name, and add `searchNews` there too if the latter.

Run: `grep -n "searchNews\|search_news" src/lib/agents/analysis/tools/index.ts src/lib/agents/analysis/index.ts`
Expected: at least the import, the export and the `toolInfo` entry; plus an entry in `analysis/index.ts` if that file enumerates tools explicitly.

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run src/lib/agents/analysis/tools/search_news.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: Full verification**

```bash
pnpm tsc --noEmit
pnpm test
pnpm --filter data-pipeline tsc
pnpm --filter data-pipeline test
```

Expected: all four clean. Report the actual output; do not claim success without it.

- [ ] **Step 7: Commit**

```bash
git add src/lib/agents/analysis/tools/search_news.ts \
        src/lib/agents/analysis/tools/search_news.test.ts \
        src/lib/agents/analysis/tools/index.ts
git commit -m "feat(rss): add search_news agent tool over the news lake"
```

---

### Task 22: Playwright E2E spec

**Files:**
- Create: `e2e/data-navigator.spec.ts`

**Interfaces:**
- Consumes: the seeded fixture items from Task 5 and the page from Task 20.

Before writing, read `e2e/smart-files.spec.ts` and `e2e/helpers/` to copy this suite's login/workspace bootstrap — the spec below assumes the same helper names. If they differ, adapt rather than inventing new ones.

- [ ] **Step 1: Read the existing suite conventions**

```bash
ls e2e/helpers/
sed -n '1,40p' e2e/smart-files.spec.ts
```

Note how a test authenticates, how it reaches a workspace-scoped URL, and whether flags are forced via env or storage state.

- [ ] **Step 2: Write the spec**

Create `e2e/data-navigator.spec.ts`, substituting the helper imports observed in Step 1:

```ts
import { test, expect } from '@playwright/test';

// Requires DATA_NAVIGATOR_ENABLED=true and `pnpm db:seed` fixture data.
test.describe('Data Navigator', () => {
  test.beforeEach(async ({ page }) => {
    // Replace with this suite's standard login/workspace helper.
    await page.goto('/data-navigator');
  });

  test('lists news items and previews the first one', async ({ page }) => {
    const list = page.getByRole('listbox', { name: 'News items' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('option').first()).toBeVisible();

    // The first item is auto-selected, so the preview shows a headline.
    await expect(page.getByRole('article')).toBeVisible();
  });

  test('selecting an item swaps the preview', async ({ page }) => {
    const options = page.getByRole('listbox', { name: 'News items' }).getByRole('option');
    const secondTitle = (await options.nth(1).innerText()).split('\n')[1];

    await options.nth(1).click();

    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('article')).toContainText(secondTitle.slice(0, 20));
  });

  test('a category chip narrows the list and Clear restores it', async ({ page }) => {
    const options = page.getByRole('listbox', { name: 'News items' }).getByRole('option');
    const before = await options.count();

    await page.getByRole('button', { name: 'New Funding' }).click();
    await expect(page.getByRole('button', { name: 'New Funding' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect.poll(() => options.count()).toBeLessThan(before);

    await page.getByRole('button', { name: 'Clear' }).click();
    await expect.poll(() => options.count()).toBe(before);
  });

  test('search replaces the feed with ranked matches', async ({ page }) => {
    await page.getByLabel('Search news').fill('sample headline');
    const options = page.getByRole('listbox', { name: 'News items' }).getByRole('option');
    await expect(options.first()).toBeVisible();
    await expect(options.first()).toContainText('sample headline');
  });
});
```

- [ ] **Step 3: Run the spec**

Run: `pnpm test:e2e data-navigator`
Expected: 4 passing tests. If login fails, the helper import from Step 1 was not applied — fix that rather than weakening the assertions.

- [ ] **Step 4: Commit**

```bash
git add e2e/data-navigator.spec.ts
git commit -m "test(rss): add Data Navigator e2e coverage"
```

---

### Task 23: Documentation

**Files:**
- Modify: `README.md`
- Modify: `data-pipeline/README.md`

**Interfaces:** none — this is the architecture-change documentation the repo requires.

- [ ] **Step 1: Document the architecture in the root README**

Add a section to `README.md` near the other subsystem descriptions:

```markdown
## Data Navigator (RSS news lake)

A global, cross-workspace news lake ingested from ~263 curated RSS feeds across
five categories (expert insights, market assessment, new funding, M&A /
partnerships, industry reports).

- **Schema:** `rss` (pipeline-owned, migrations in `data-pipeline/migrations`).
  `rss.feeds` is the runtime-editable catalog; `rss.items` holds metadata for
  every ingested item; `rss.item_chunks` holds pgvector embeddings for the
  LLM-selected subset; `rss.ingest_runs` records each run.
- **Ingest:** two scheduled Lambdas in `data-pipeline` — `rss-poll` (30 min,
  conditional GET + S3 bronze archive) and `rss-enrich` (10 min, Haiku
  classification → article fetch → Bedrock Titan embeddings).
- **Volume control:** `RSS_DAILY_CAP_PER_CATEGORY` (default 25) caps selected
  items per category per UTC day.
- **Serving:** `DataNavigatorService` → `/api/data-navigator/*` → the
  `/data-navigator` page, gated by `DATA_NAVIGATOR_ENABLED`.
- **RAG:** the `search_news` agent tool runs hybrid vector + trigram search.
- **Feed admin:** `X-Api-Secret`-gated routes under `/api/auth/rss-feeds`;
  bulk import the checked-in catalog with `pnpm rss:import-feeds`.

Bedrock is not available in `ap-southeast-3`, so embedding calls use
`BEDROCK_REGION` (default `ap-southeast-1`).

Design: `docs/superpowers/specs/2026-09-02-data-navigator-rss-lake-design.md`.
```

- [ ] **Step 2: Document the Lambdas in the pipeline README**

Add to `data-pipeline/README.md`:

```markdown
## RSS news lake

Two further scheduled functions, independent of the email pipeline:

1. `rss-poll` (every 30 min) conditional-GETs every `status = 'active'` row in
   `rss.feeds`, normalizes entries, inserts genuinely-new ones into
   `rss.items`, archives them as NDJSON to `s3://mna-<env>-rss-lake/bronze/`,
   and updates per-feed health (a feed retires to `dead` after 10 consecutive
   failures).
2. `rss-enrich` (every 10 min) drains three queues: Haiku relevance
   classification (with a per-category daily cap), full-article extraction for
   selected items (3 attempts), and Bedrock Titan embeddings into
   `rss.item_chunks`.

Unlike the email path, these functions do use S3 — a separate bucket, with an
IAM policy scoped to its `bronze/` prefix. The email functions still make no S3
calls.

Local:

```bash
pnpm --filter data-pipeline invoke rssPoll '{}'
pnpm --filter data-pipeline invoke rssEnrich '{}'
```
```

- [ ] **Step 3: Commit**

```bash
git add README.md data-pipeline/README.md
git commit -m "docs: document the Data Navigator RSS news lake architecture"
```

---

**Phase 5 exit criteria:** the chat agents can answer questions from ingested news via `search_news`; the page has e2e coverage; both READMEs describe the new subsystem.

---

## Final verification

Before opening a PR, run every gate and paste the real output:

```bash
pnpm tsc --noEmit
pnpm test
pnpm --filter data-pipeline tsc
pnpm --filter data-pipeline test
pnpm --filter data-pipeline build
pnpm test:e2e data-navigator
cd terraform/s3-rss && terraform fmt -check && terraform validate && cd -
cd data-pipeline/terraform/pipeline-compute && terraform fmt -check && terraform validate && cd -
```

Then run the repo's own architecture review, which checks the layering, N+1, migration and flag conventions this plan is built on:

```
/review-implementation
```

Expected verdict: PASS. Fix anything it flags as NEEDS_FIX before the PR.

## Deferred (explicitly out of scope)

Recorded so they are not mistaken for oversights:

- Weekly feed-validation Lambda with autodiscovery repair (PoC `validate_feeds.py`) — poll-time health covers detection.
- Cross-source story dedupe (MinHash / embedding similarity on titles).
- A feed-management UI — admin API only.
- Licensed research ingestion (UBS, Hana, Refinitiv) — no public RSS.
- `content_text` pruning — retention is indefinite by decision.
