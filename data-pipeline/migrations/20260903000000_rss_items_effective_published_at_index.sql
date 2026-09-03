-- Index the "trusted publish date" expression the Data Navigator feed now
-- sorts and pages by.
--
-- `RssItemRepository` orders and keyset-paginates on
--   CASE WHEN published_at > ingested_at THEN ingested_at ELSE published_at END
-- rather than on `published_at` directly, because a feed's <pubDate> is
-- publisher-controlled and is sometimes stamped in the future, which pinned
-- such an item to the top of a newest-first feed until real time caught up.
--
-- The existing idx_rss_items_published_at / idx_rss_items_category_published
-- are on the bare column, so a btree cannot answer an ORDER BY over that
-- expression — the feed degrades to a sequential scan plus an external sort,
-- which is exactly the kind of unbounded read this repo's performance rules
-- forbid. These two expression indexes restore index-ordered scans for the
-- unfiltered feed and for the category-filtered feed respectively.
--
-- The expression is IMMUTABLE (timestamptz comparison and CASE over two
-- columns of the same row), which is what makes it legal to index.
--
-- The column ordering mirrors the queries exactly — DESC NULLS LAST on the
-- expression, then id DESC — so the same index serves both the ORDER BY and
-- the `(expr, id) < (cursor_expr, cursor_id)` row comparison the cursor uses.
-- The old column indexes are deliberately left in place: the enrich-stage
-- queues and any remaining raw-column filters still use them, and dropping an
-- index is not a change worth bundling with an additive one.

CREATE INDEX IF NOT EXISTS idx_rss_items_effective_published
  ON rss.items (
    (CASE WHEN published_at > ingested_at THEN ingested_at ELSE published_at END) DESC NULLS LAST,
    id DESC
  );

CREATE INDEX IF NOT EXISTS idx_rss_items_category_effective_published
  ON rss.items (
    category,
    (CASE WHEN published_at > ingested_at THEN ingested_at ELSE published_at END) DESC NULLS LAST,
    id DESC
  );
