-- Machine translation of non-English news items.
--
-- The feed catalog spans several regions, so a meaningful slice of the lake
-- arrives in Japanese, Korean, Chinese, German, Spanish, Portuguese and so
-- on. Those items were previously stored and embedded verbatim, which made
-- them unreadable in the Data Navigator and effectively invisible to hybrid
-- search (the query embedding and the trigram half are both English).
--
-- The enrich Lambda now runs a translation stage between content extraction
-- and embedding: it detects the language locally (no LLM call for the English
-- majority) and, for anything else, has Haiku translate title/summary/body
-- into these `*_en` columns. The ORIGINAL text is never overwritten — the
-- reading pane offers a "display in original language" toggle, so both
-- versions have to survive.
--
-- Scope note: only `relevance = 'selected'` items are translated, mirroring
-- content extraction. Raw intake is thousands of items a day; translating all
-- of it would cost far more than it is worth when ~75/day are ever read.

ALTER TABLE rss.items
  ADD COLUMN IF NOT EXISTS language             TEXT,
  ADD COLUMN IF NOT EXISTS translation_status   TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS title_en             TEXT,
  ADD COLUMN IF NOT EXISTS summary_en           TEXT,
  ADD COLUMN IF NOT EXISTS content_text_en      TEXT,
  ADD COLUMN IF NOT EXISTS translated_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS translation_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS translation_error    TEXT;

-- 'none'       — the translation stage has not looked at this item yet.
-- 'not_needed' — looked at it; the text is already English (or too short to
--                tell, in which case we deliberately do not spend a call).
-- 'pending'    — a translation attempt failed but the attempt budget is not
--                spent, so the next run retries it.
-- 'translated' — `*_en` columns are populated.
-- 'failed'     — attempt budget exhausted; the item stays readable in its
--                original language and is embedded from that text.
ALTER TABLE rss.items
  DROP CONSTRAINT IF EXISTS rss_items_translation_status_check;
ALTER TABLE rss.items
  ADD CONSTRAINT rss_items_translation_status_check
  CHECK (translation_status IN ('none', 'not_needed', 'pending', 'translated', 'failed'));

-- Backfill: settle everything that has already been embedded.
--
-- This is NOT cosmetic. The embed queue is now gated on translation having
-- resolved, so without this every pre-existing row would sit at the default
-- 'none' and be simultaneously (a) unembeddable and (b) queued for
-- translation behind the entire historical corpus — the translate stage
-- drains oldest-first, so newly fetched items would be stuck at the tail
-- while the stage re-examined years of already-indexed English. That is a
-- pipeline stall, not a deadlock, but it lasts as long as it takes to walk
-- the backlog.
--
-- 'not_needed' is the right terminal state for these rows specifically:
-- their chunks were already indexed from whatever text existed at the time,
-- so translating one now would also require dropping and re-embedding its
-- chunks to have any effect on search. That is a backfill job, not a
-- migration. `language` is deliberately left NULL rather than stamped 'en' —
-- nothing here established it, and claiming otherwise would put a made-up
-- fact in the column the UI reads.
--
-- Rows that are NOT yet embedded keep the default 'none' and flow through
-- the translate stage normally. That set is bounded by the embed queue's own
-- throughput, so it is small in any healthy environment.
UPDATE rss.items
   SET translation_status = 'not_needed'
 WHERE embedded_at IS NOT NULL;

-- The translate stage's driving query: oldest-first over selected items whose
-- content fetch has resolved and whose translation state is still open. Kept
-- partial so it stays tiny — after the backfill above the queue only ever
-- holds genuinely-new work, and the vast majority of rows are
-- 'not_needed'/'translated' and never re-read here.
CREATE INDEX IF NOT EXISTS idx_rss_items_translation_queue
  ON rss.items (ingested_at)
  WHERE relevance = 'selected' AND translation_status IN ('none', 'pending');

-- The lexical half of hybrid search now also ILIKEs `title_en`, so a user
-- typing an English query can reach a translated foreign-language headline.
-- Without this trigram index that predicate degrades to a sequential scan
-- over the whole lake — the exact unbounded read the existing
-- idx_rss_items_title_trgm was added to prevent for `title`.
CREATE INDEX IF NOT EXISTS idx_rss_items_title_en_trgm
  ON rss.items USING gin (title_en gin_trgm_ops);
