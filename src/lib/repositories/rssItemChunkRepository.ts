import { sql } from 'drizzle-orm';
import { EMBEDDING_DIMENSIONS } from '@/lib/bedrock';
import type { DbClient } from './types';
import { EFFECTIVE_PUBLISHED_AT_JOINED_ITEM } from './rssItemRepository';
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
 *
 * Filter arrays are rendered as `IN (...)` lists built with `sql.join`, NOT
 * `= ANY(${array})`. Verified against the live local DB: with this app's
 * driver (drizzle-orm/node-postgres over `pg`), interpolating a plain JS
 * array into a `sql` template does not bind it as a single Postgres array
 * parameter — Drizzle spreads it into one bound parameter per element inside
 * a parenthesized list (`ANY(($1, $2))`), which Postgres then rejects with
 * "op ANY/ALL (array) requires array on right side" (error 42809). Building
 * an explicit `IN (${sql.join(items.map(v => sql`${v}`), sql`, `)})` list
 * uses that same per-element parameter spreading correctly and was confirmed
 * to return matching rows against the real `rss.items` table.
 *
 * Each filter clause is its own `sql`` fragment, conditionally interpolated
 * into the main template (`${filters.categories ? sql`...` : sql``}`)
 * rather than built imperatively with `SQL.prototype.append()`. Checked with
 * `PgDialect().sqlToQuery()`: both forms compile to the same SQL text
 * (modulo incidental whitespace) with identical bound params — the nested
 * form is not a functional regression, just a different way to compose the
 * same statement, so it's kept for being the more declarative read.
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
    // pgvector accepts the '[1,2,3]' text form for a vector literal. This is
    // the one place a bound parameter cannot carry the type — the query must
    // interpolate the literal text and cast it.
    const vectorLiteral = `[${embedding.join(',')}]`;

    const categoryClause = filters.categories
      ? sql`AND i.category IN (${sql.join(
          filters.categories.map((c) => sql`${c}`),
          sql`, `,
        )})`
      : sql``;
    const sourceNameClause = filters.sourceNames
      ? sql`AND i.source_name IN (${sql.join(
          filters.sourceNames.map((s) => sql`${s}`),
          sql`, `,
        )})`
      : sql``;
    const regionClause = filters.regions
      ? sql`AND i.region IN (${sql.join(
          filters.regions.map((r) => sql`${r}`),
          sql`, `,
        )})`
      : sql``;
    // Same trusted date the list/detail/text-search paths use. Filtering the
    // raw `published_at` here would make the two halves of hybrid search
    // disagree about a misattributed item: unpinned from the feed but still
    // dropped from a `to=now` vector query, or pulled into a `from` window it
    // does not belong in.
    const fromClause = filters.from
      ? sql`AND ${EFFECTIVE_PUBLISHED_AT_JOINED_ITEM} >= ${filters.from}::timestamptz`
      : sql``;
    const toClause = filters.to
      ? sql`AND ${EFFECTIVE_PUBLISHED_AT_JOINED_ITEM} <= ${filters.to}::timestamptz`
      : sql``;
    // Relevance lives on the item (`i`), not the chunk (`c`) — the curated
    // ~75/day are marked on `rss.items.relevance`, chunks have no such column.
    const selectedOnlyClause = filters.selectedOnly ? sql`AND i.relevance = ${'selected'}` : sql``;

    // `DISTINCT ON (c.item_id) ... ORDER BY c.item_id, distance` (a Postgres
    // requirement: DISTINCT ON's leading ORDER BY columns must match its
    // distinct columns) must run to completion, UNBOUNDED, before the
    // top-K cut is applied. Putting `LIMIT k` on that same (deduplicating)
    // query — as this used to do — applies the limit to the set already
    // ordered by `item_id`, so it returns the k lexicographically-smallest
    // item UUIDs, NOT the k nearest by distance. Verified against the live
    // DB: with 5 probe chunks and `LIMIT 2`, that shipping form returned
    // distances 0.80388 and 0.55279 (the two FURTHEST), while this
    // subquery form returned 0.01942 and 0.10557 (the two nearest).
    //
    // The fix: do the de-duplication in an inner subquery with NO limit,
    // then apply `ORDER BY distance ASC LIMIT k` in the outer query, which
    // is free to re-sort the already-deduplicated rows by distance. The
    // JS `.sort()` that used to live after this call is now redundant
    // (the outer query already returns rows in distance order) and has
    // been removed rather than kept as a no-op.
    const { rows } = await this.db.execute<{
      item_id: string;
      chunk_text: string;
      distance: number | string;
    }>(sql`
      SELECT item_id, chunk_text, distance
      FROM (
        SELECT DISTINCT ON (c.item_id)
          c.item_id::text AS item_id,
          c.text          AS chunk_text,
          (c.embedding <=> ${vectorLiteral}::vector) AS distance
        FROM rss.item_chunks c
        JOIN rss.items i ON i.id = c.item_id
        WHERE TRUE
          ${categoryClause}
          ${sourceNameClause}
          ${regionClause}
          ${fromClause}
          ${toClause}
          ${selectedOnlyClause}
        ORDER BY c.item_id, distance ASC
      ) deduped
      ORDER BY distance ASC
      LIMIT ${limit}
    `);

    return rows.map((r) => ({ ...r, distance: Number(r.distance) }));
  }
}
