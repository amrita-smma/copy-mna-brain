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
