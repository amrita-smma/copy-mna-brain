# RFC: Data Navigator — RSS News Lake

- **Status**: Draft (awaiting review)
- **Date**: 2026-09-02
- **Author**: Nico Alimin + Claude
- **PoC**: `/Users/nico/Downloads/rss-lake-poc` (verified 2026-09-02: 263 live feeds, 3,143 items on first run, dedupe + conditional GET confirmed on re-run)

## 1. Summary

Productionize the RSS lake PoC inside mna-brain: scheduled Lambdas in the existing
`data-pipeline` stack poll ~263 curated RSS/Atom feeds across 5 intelligence
categories, land raw payloads in an S3 bronze archive, and upsert normalized item
metadata into a new dedicated `rss` Postgres schema. An enrichment stage classifies
new items with Haiku, fetches full article content for the selected subset
(~75/day), and embeds it with AWS Bedrock into pgvector for RAG. A new
feature-flagged **Data Navigator** page shows a filterable news list (left) with a
full-content preview (right), and a new agent tool gives the chat agents semantic
search over the news index.

### Requirement mapping

| # | Requirement | Where addressed |
|---|-------------|-----------------|
| 1 | Dedicated "Data Navigator" page, list left / preview right | §7.4 |
| 2 | Intuitive filters over the 5 categories, ≥50 feeds each | §5 (catalog), §7.2/§7.4 (filters) |
| 3 | Full contents fetched from URL and stored | §6.3 (selected subset; rationale in §10) |
| 4 | Contents queryable via RAG / vector DB | §6.4, §8 |
| 5 | Storage: Postgres vs NoSQL vs Parquet | §10 decision log — Postgres + S3 bronze |
| 6 | Feed config changeable at runtime, global across workspaces | §5 |

### Non-goals (this iteration)

- Licensed sell-side research ingestion (UBS/Hana/Refinitiv PDFs — no public RSS;
  future API integration).
- Cross-source story dedupe (same story from many outlets — MinHash/embedding
  similarity is a listed future enhancement).
- A feed-management UI (admin API only; UI can come later).
- Workspace-scoped feeds or per-user subscriptions (catalog is global by design).
- A "daily digest" email/notification product on top of the gold layer.

## 2. Background

The PoC (Python) validated the hard parts:

- **Catalog**: `feeds_final.csv` — 263 live-validated feeds: expert_insights 56,
  market_assessment 51, new_funding 50, ma_partnerships 54, industry_reports 52.
  Mix of curated publisher/wire/regulator feeds plus Google News / Bing News
  keyword query feeds. Columns: `category, source_name, feed_url, region, notes,
  status, entries`.
- **Idempotent ingest**: conditional GET (ETag/Last-Modified) + sha256(guid|link)
  dedupe ledger → re-runs are cheap and duplicate-free.
- **Volume**: thousands of raw items/day; the business target is ~75 relevant
  items/day, so selection is a first-class stage, not an afterthought.
- **Feed rot**: ~35% of the original seed catalog was dead/moved — health tracking
  and runtime configurability are required, not nice-to-have.

## 3. Decisions already made (with Nico, 2026-09-02)

| Decision | Choice |
|----------|--------|
| Content scope | Metadata for ALL items; full content + embeddings only for the LLM-selected subset (~75/day) |
| Ingest runtime | TypeScript port into `data-pipeline` (AWS SAM Lambdas), two-stage poll/enrich (Approach B) |
| Storage | Postgres `rss` schema on existing RDS PG16 + pgvector; raw NDJSON bronze archive on S3 |
| Embeddings | AWS Bedrock — `amazon.titan-embed-text-v2:0`, 1024 dims |
| Feed catalog | Global `rss.feeds` table, seeded from `feeds_final.csv`, managed via X-Api-Secret admin routes |
| Gold filter | Haiku relevance classification from day one (plus per-category daily caps) |

Rationale for each is in the decision log (§10).

## 4. Architecture overview

```
                       ┌─────────────────────────── data-pipeline (AWS) ───────────────────────────┐
                       │                                                                            │
 263 RSS feeds ──────► │  rss-poll (λ, every 30 min)                rss-enrich (λ, every 10 min)    │
                       │   • conditional GET all active feeds        • Haiku classification batch   │
                       │   • parse + normalize + sha256 dedupe       • per-category daily caps      │
                       │   • raw NDJSON → S3 bronze                  • fetch article full content   │
                       │   • upsert metadata → rss.items             • chunk + Bedrock embeddings   │
                       │   • feed health (ETag, failures)            • → rss.items, rss.item_chunks │
                       └───────────────┬────────────────────────────────────┬───────────────────────┘
                                       │                                    │
                                       ▼                                    ▼
                         S3 rss/bronze/… (raw archive)      Postgres: rss.feeds / rss.items /
                                                            rss.item_chunks (pgvector) / rss.ingest_runs
                                                                             ▲
                       ┌──────────────────────── mna-brain (Vercel) ─────────┴─────────────────────┐
                       │  /data-navigator page ◄─ /api/data-navigator/* ◄─ DataNavigatorService    │
                       │  agent tool `search_news` ──► Bedrock (query embed) + pgvector search     │
                       │  /api/auth/rss-feeds* (admin, X-Api-Secret) ──► feed catalog CRUD/import  │
                       └────────────────────────────────────────────────────────────────────────────┘
```

The two-Lambda split mirrors the existing `vault-archive-start` / `vault-archive-poll`
pattern: polling never blocks on slow scrapes or LLM calls; each stage is
idempotent and independently observable via `rss.ingest_runs`.

## 5. Feed catalog (`rss.feeds`)

Global — deliberately **not** workspace-scoped (requirement #6: "generic across all
workspaces"). This is a documented deviation from the usual workspace-scoped
repository pattern, same as parts of the `analytics` schema.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `category` | text | `expert_insights \| market_assessment \| new_funding \| ma_partnerships \| industry_reports` (pg enum) |
| `source_name` | text | e.g. "DealStreetAsia" |
| `feed_url` | text UNIQUE | |
| `region` | text | free text from catalog (US, UK, India, Global, …) |
| `tier` | text | `curated \| query` — query = Google/Bing News keyword feeds; used as a classification signal |
| `status` | text | `active \| paused \| dead` |
| `notes` | text | |
| `etag`, `last_modified` | text | HTTP conditional-GET state (replaces PoC's `http_cache.json`) |
| `last_polled_at`, `last_success_at` | timestamptz | |
| `consecutive_failures` | int default 0 | poll increments on failure, resets on success; ≥ 10 → `status = 'dead'` |
| `created_at`, `updated_at` | timestamptz | |

**Seeding**:
- Commit the validated catalog as `data-pipeline/fixtures/rss-feeds.csv`
  (`feeds_final.csv`, status OK/REPAIRED rows, `tier` derived from source name).
- **Staging/production**: bulk import via admin endpoint
  `POST /api/auth/rss-feeds/import` (accepts JSON array; idempotent upsert on
  `feed_url`).
- **Local dev**: extend `scripts/seed.ts` (per repo convention — no new standalone
  seeders) to upsert a small representative subset (~3 feeds per category) plus a
  handful of fixture items so the page renders without running the pipeline.

**Admin API** (all under `/api/auth/*`, gated by `X-Api-Secret` in `src/proxy.ts`
matcher; no per-handler session check, straight to `createDb()`/`createContainer`):

- `GET  /api/auth/rss-feeds` — list with health fields (filter by category/status)
- `POST /api/auth/rss-feeds` — create one
- `POST /api/auth/rss-feeds/import` — bulk upsert (the seeding path)
- `PATCH/DELETE /api/auth/rss-feeds/:id` — edit / pause / remove
- Add `/api/auth/rss-feeds` and `/api/auth/rss-feeds/:path*` to the `proxy.ts` matcher.

## 6. Ingestion pipeline (data-pipeline)

New code lives beside the email pipeline: `data-pipeline/src/lambda/rssPoll.ts`,
`data-pipeline/src/lambda/rssEnrich.ts`, handlers in `data-pipeline/src/handlers/`,
repositories in `data-pipeline/src/repositories/`. Schema tables are defined in the
shared `src/lib/db/schema.ts` (like `analytics.*`), migrations generated with
`pnpm db:migration:new <name> data-pipeline/migrations` (pipeline-owned tables,
same precedent as `analytics`).

### 6.1 Tables

**`rss.items`** — one row per unique news item (metadata for everything):

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `item_hash` | text UNIQUE | sha256(guid \| link) — the dedupe key, ported from PoC |
| `feed_id` | uuid FK → rss.feeds | |
| `category`, `source_name`, `region`, `feed_tier` | text | denormalized from feed at ingest time (feed rows change; items are immutable facts) |
| `title` | text | |
| `link` | text | canonical article URL |
| `summary` | text | RSS summary/description, HTML-stripped, ≤ 2000 chars |
| `authors`, `tags` | text | `; `-joined, as in PoC |
| `published_at` | timestamptz nullable | |
| `ingested_at` | timestamptz | |
| `relevance` | text | `pending \| selected \| rejected` |
| `relevance_score` | real nullable | 0–1 from Haiku |
| `llm_labels` | jsonb nullable | `{ companies: string[], topics: string[], reason: string }` |
| `classified_at` | timestamptz nullable | |
| `content_status` | text | `none \| pending \| fetched \| failed` (`none` for rejected items) |
| `content_text` | text nullable | extracted full article text |
| `content_fetched_at` | timestamptz nullable | |
| `content_attempts` | int default 0 | fail budget = 3 |
| `content_error` | text nullable | |
| `embedded_at` | timestamptz nullable | |

Indexes: `item_hash` unique; `(published_at DESC)`; `(category, published_at DESC)`;
partial index on `relevance = 'pending'` and on
`(relevance = 'selected' AND content_status = 'pending')` for the enrich queues;
GIN trigram indexes on `title`, `authors`, `source_name` for the ILIKE half of
hybrid search.

**`rss.item_chunks`** — RAG index:

| Column | Type |
|--------|------|
| `id` uuid PK, `item_id` FK → rss.items ON DELETE CASCADE | |
| `chunk_index` int — UNIQUE(item_id, chunk_index) | |
| `text` text | |
| `embedding` vector(1024) — HNSW index, cosine | |

**`rss.ingest_runs`** — observability (mirrors `analytics.email_process_runs`
philosophy): `id, kind ('poll'|'enrich'), started_at, finished_at, stats jsonb,
error text`. Stats: feeds polled / unchanged / failed, items seen / new,
classified / selected, fetched / fetch-failed, chunks embedded.

Migration 0 also runs `CREATE EXTENSION IF NOT EXISTS vector;`,
`CREATE EXTENSION IF NOT EXISTS pg_trgm;` and `CREATE SCHEMA IF NOT EXISTS rss;`
(RDS PG16 ships both).

### 6.2 `rss-poll` — every 30 minutes

Direct TypeScript port of `ingest.py` (~200 lines):

1. Load `rss.feeds` where `status = 'active'`.
2. Concurrent conditional GETs (p-limit ~12, 20 s timeout, PoC User-Agent).
   304 / failure → update health counters only.
3. Parse with `rss-parser`, normalize exactly as the PoC (`clean()`, entry
   timestamp fallbacks, ≤ 25 items/feed), compute `item_hash`.
4. `INSERT … ON CONFLICT (item_hash) DO NOTHING` → the rows actually inserted are
   the "genuinely new" set (replaces the SQLite ledger).
5. Write new items as NDJSON to
   `s3://<pipeline-bucket>/rss/bronze/category=<cat>/ingest_date=YYYY-MM-DD/run_<ts>.ndjson`
   (immutable audit/replay log).
6. Persist per-feed `etag`/`last_modified`/health; write an `ingest_runs` row.

263 feeds × conditional GET fits comfortably in one Lambda run (PoC: whole run in
well under a minute when most feeds 304).

### 6.3 `rss-enrich` — every 10 minutes

Three bounded, independently idempotent steps per run (each capped so the run
stays far inside the 15-min Lambda limit):

**a) Classify.** Pull up to 200 `relevance = 'pending'` items (newest first).
Batch ~20 per Haiku prompt (`claude-haiku-4-5`): given category, source, tier,
title, summary → `{ relevant: bool, score: 0–1, companies[], topics[], reason }`.
Per-category **daily selection cap** (`RSS_DAILY_CAP_PER_CATEGORY`, default 25 →
125/day ceiling across the 5 categories): once today's `selected` count for a
category hits the cap, further relevant items in that category are still scored
but marked `rejected` with reason `cap` — deterministic volume control. Query-tier feeds require a higher score threshold
than curated feeds. Selected → `content_status = 'pending'`.

**b) Fetch content.** Up to 50 items `selected + content_status = 'pending'`:
fetch `link` (15 s timeout), extract readable text with
`@extractus/article-extractor` (lightweight, no jsdom). Success → `content_text`
(capped 200 KB), `fetched`. Failure → increment `content_attempts`; at 3 →
`failed` (UI falls back to summary + original link; item is still listed).
Paywalled/robots-blocked pages simply exhaust the budget — no circumvention.

**c) Embed.** Items `fetched + embedded_at IS NULL`: chunk `title + "\n\n" +
content_text` at ~1,200 tokens with 150 overlap, embed each chunk via Bedrock
`amazon.titan-embed-text-v2:0` (1024 dims), insert `rss.item_chunks`, stamp
`embedded_at`. Items that failed fetching get a single chunk from
title + summary so RAG still sees them.

### 6.4 Infra changes

- **SAM** (`data-pipeline/template.yaml`): two new functions `rss-poll`,
  `rss-enrich` (nodejs20.x, same layout as vault functions).
- **Terraform** (`data-pipeline/terraform/pipeline-compute`): two EventBridge
  schedules — `rate(30 minutes)` and `rate(10 minutes)` (existing module pattern;
  Makefile init targets already exist).
- **IAM**: the RSS functions get `s3:PutObject` on the bronze prefix and
  `bedrock:InvokeModel` on the Titan embed model. (Note: the email functions
  deliberately have **no** S3 permissions — keep the roles separate so that
  privacy boundary is untouched.)
- **S3**: a dedicated bucket `mna-<env>-rss-lake` added to `terraform/s3`
  (versioning off, public access blocked, bronze written under
  `bronze/category=<cat>/ingest_date=…`). Separate from the email pipeline so
  its no-S3 privacy boundary is untouched.
- **Config**: reuse `/mna/<environment>/pipeline` SSM (DB + Anthropic already
  there); add Bedrock region/model id as plain env vars.

## 7. App integration (mna-brain)

Standard layering: repositories → service → routes → client API → view.

### 7.1 Repositories (`src/lib/repositories/`)

- **`RssFeedRepository`** — global CRUD + bulk upsert on `feed_url` + health
  listing. Not workspace-scoped (documented deviation, §5).
- **`RssItemRepository`** — `listItems(filters, cursor, limit)` with keyset
  pagination on `(published_at, id)`; filters: categories[], sourceNames[],
  regions[], from/to, `selectedOnly`; `findById`; `findByIds` (batched, empty
  guard) for hydrating hybrid-search hits; `textSearch(q, filters, limit)` —
  ILIKE over `title`, `authors`, `source_name` with a trigram index. All list
  queries are single batched statements — no per-row lookups (N+1 rule).
- **`RssItemChunkRepository`** — `vectorSearch(embedding: number[], topK,
  filters)`: cosine distance over HNSW, joined to `rss.items` in one query,
  returns chunk text + item metadata.

### 7.2 Service (`src/lib/services/dataNavigatorService.ts`)

Registered in `createContainer`, constructor-injected repositories + a thin
`BedrockEmbeddingClient` (`src/lib/bedrock.ts`, uses the app's existing AWS
credentials — same account as S3):

- `listItems(filters)` → `{ items, nextCursor }`
- `getItem(id)` → full row incl. `content_text`
- `searchNews(query, { topK, categories?, from? })` → **hybrid search**: embed
  the query via Bedrock and run `vectorSearch`, concurrently run
  `RssItemRepository.textSearch` (ILIKE over `title`, `authors`, `source_name`),
  then merge — an item matched by both ranks above one matched by either, ILIKE
  hits carry a fixed lexical score so exact title/author lookups always surface
  even when semantically distant. Returns `{ title, source, category,
  publishedAt, link, snippet, score, matchedBy: 'vector' | 'text' | 'both' }`.
  Used by both the UI search box and the agent tool.
- `listFilterOptions()` → distinct source names/regions per category for the
  filter UI (one grouped query, cacheable)
- Feed admin passthroughs for the admin routes.

### 7.3 API routes

- `GET /api/data-navigator/items` — list w/ query-param filters + cursor
- `GET /api/data-navigator/items/[id]` — detail (full content)
- `GET /api/data-navigator/filters` — filter options
- `GET /api/data-navigator/search?q=…` — hybrid search (vector + ILIKE)
- Admin routes per §5. All follow the standard try/catch +
  `NextResponse.json({ data })` convention; session auth via existing middleware
  for the non-admin routes.

### 7.4 Page (`/data-navigator`)

- Feature flag `dataNavigatorEnabled` = `booleanFlag("DATA_NAVIGATOR_ENABLED")` in
  `src/lib/flags.ts`; `showDataNavigator` prop threaded through `DashboardLayout`
  per the flag convention (same prop on every render branch).
- Server page resolves the flag; view is a client component using
  `src/lib/api/dataNavigator.ts` wrappers.
- **Layout**: master–detail. Left: filter bar (category chips, source/region
  selects, date range, hybrid search box, "curated picks only" = selectedOnly)
  above an infinite-scroll list (title, source, category badge, relative time,
  1-line summary). Right: preview pane — title, source, authors, published date,
  tags, then `content_text` when fetched, else summary + prominent "Read
  original" link. Keyboard ↑/↓ navigation between items.
- Empty/loading/error branches all render `DashboardLayout` with the same flag
  props (flicker rule).

### 7.5 Agent RAG tool

Per the agent design pattern: `search_news` added to the existing chat/analysis
agent under its `tools/` folder (own file + own test, registered in
`tools/index.ts`). Input `{ query, categories?, publishedAfter?, topK = 8 }` →
`DataNavigatorService.searchNews` → compact markdown list with title, source,
date, snippet, link. No new agent is created; this is one new tool.

## 8. RAG design notes

- **Index unit**: chunk (~1,200 tokens, 150 overlap), title prefixed to every
  chunk for retrieval quality.
- **Query path**: Bedrock Titan v2 also embeds the query (symmetric model).
- **Post-filter**: SQL WHERE on category/date happens in the same statement as
  the vector ORDER BY (pgvector supports filtered HNSW scans; at our scale —
  ~27k selected items/year ≈ low-100k chunks — this is trivial).
- **Fallback**: items whose content fetch failed still get a title+summary chunk,
  so recall degrades gracefully rather than silently dropping stories.

## 9. Testing

Per repo rules (vitest, no real I/O), every backend change under `src/lib` and
`data-pipeline/src` gets unit tests:

- **Pipeline**: normalization (hash stability, timestamp fallbacks, HTML
  stripping), conditional-GET state transitions, feed-health thresholds,
  classification parsing + daily-cap logic, chunker boundaries, idempotent
  re-runs (ON CONFLICT path). Repository tests with stubbed Drizzle chains.
- **App**: repository filter/cursor tests (typed `db as never` mocks), service
  tests with class-based repo mocks, `search_news` tool test via `tool.invoke`
  with mocked db/repos and a stubbed Bedrock client.
- **Fixtures**: 2–3 real RSS XML samples (incl. one Atom, one Google News feed)
  checked into `data-pipeline/fixtures/`.
- E2E: a `/data-navigator` Playwright spec against seeded fixture items (list
  renders, filter narrows, preview shows content) — after the UI lands.

## 10. Decision log (alternatives considered)

- **Postgres vs NoSQL vs Parquet** (requirement #5): access patterns are
  latest-N feed reads, point lookups, faceted filters, and vector similarity —
  all row-store strengths. Volume (~1M metadata rows/year, ~100k chunks/year) is
  small for PG16. NoSQL adds an infra + consistency story for zero benefit;
  Parquet/DuckDB is optimized for large analytical scans Nico explicitly doesn't
  need, and is a poor fit for a live UI. **Chosen: Postgres `rss` schema +
  pgvector, with S3 NDJSON bronze** as the immutable raw archive enabling future
  re-processing (better extraction/models) without re-polling feeds that no
  longer serve old entries.
- **Ingest runtime**: Vercel cron + jobs would force chunking 263 fetches +
  scraping under function duration limits; keeping the Python PoC adds a second
  language/deploy. `data-pipeline` already runs scheduled Node Lambdas against
  the same RDS with SSM config and an Anthropic key. **Chosen: data-pipeline.**
- **Pipeline shape**: single do-everything Lambda couples polling latency to
  scrape/LLM latency and re-does work on crash. **Chosen: two-stage
  poll/enrich** (Approach B), mirroring vault-archive-start/poll.
- **Content scope**: scraping + embedding all ~3k items/day is ~40× the cost for
  content mostly never read, with more paywall/robots friction. **Chosen:
  filtered subset** (~75/day) with metadata for everything.
- **Embeddings**: Voyage AI has the best retrieval quality but adds a vendor
  account; OpenAI likewise. **Chosen: Bedrock Titan v2** — IAM-native in the
  account both the Lambdas and the app already use; quality is sufficient for
  news retrieval; swappable later behind `BedrockEmbeddingClient` (re-embed from
  bronze/content if we switch).
- **Gold filter**: heuristics are free but brittle across 5 heterogeneous
  categories. **Chosen: Haiku classification from day one** (~150 batched
  calls/day ≈ $1–3/day) with deterministic daily caps on top.

## 11. Resolved questions (Nico, 2026-09-02)

1. **S3 location** → **Create a dedicated `rss` bucket** in `terraform/s3`
   (`mna-<env>-rss-lake`), separate from the email pipeline's role/permissions.
2. **Daily cap** → **125/day max**, i.e. keep the flat 25 per category per day
   (`RSS_DAILY_CAP_PER_CATEGORY`, overridable per category later without a
   schema change).
3. **Retention** → **No pruning.** `content_text` is retained indefinitely
   alongside metadata, chunks, and bronze.
4. **Feed validation Lambda** → **Deferred.** Poll-time health tracking
   (`consecutive_failures` → `dead`) plus manual admin fixes cover v1; the
   PoC's `validate_feeds.py` autodiscovery repair is a later addition.
5. **Search box** → **Hybrid.** The UI search runs the vector index *and* an
   ILIKE scan over key fields (`title`, `authors`, `source_name`), merging both
   result sets. Details in §7.2.

## 12. Delivery phases

Each phase is independently shippable and reviewable:

1. **Schema + catalog**: `rss` schema migration (extension, tables, indexes),
   Drizzle definitions, `RssFeedRepository`, admin routes + proxy matcher, CSV
   fixture + import endpoint, seed.ts additions.
2. **Poll pipeline**: `rss-poll` Lambda + S3 bronze + health tracking + SAM/TF
   wiring, running in staging.
3. **Enrich pipeline**: Haiku classification, content fetch, chunk + embed.
4. **App API + page**: repositories/service/routes, `/data-navigator` view behind
   `DATA_NAVIGATOR_ENABLED`.
5. **RAG tool**: `search_news` agent tool.
