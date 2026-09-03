import { and, desc, eq, getTableColumns, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Column, SQL } from 'drizzle-orm';
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
 * The publish timestamp we actually trust.
 *
 * `published_at` comes from the feed's `<pubDate>`, which is publisher-
 * controlled and is wrong often enough to matter: a timezone bug, a
 * mis-set clock, or a scheduled post can stamp an item hours or days
 * ahead of when it was actually published. In a newest-first feed such an
 * item pins itself to the very top and stays there — ahead of genuinely
 * newer stories — until real time catches up with the bad date.
 *
 * When an item claims to have been published AFTER we fetched it, that
 * claim is not credible, so we fall back to `ingested_at` — the one
 * timestamp in the row we produced ourselves and can vouch for.
 *
 * Compared against `ingested_at` rather than `now()` on purpose. `now()`
 * would make a row's sort key change as the wall clock advances, which
 * both reshuffles the feed under a reader mid-scroll and can break the
 * keyset cursor below (a cursor captured before the flip would skip or
 * repeat rows after it). Against `ingested_at` the expression is a pure
 * function of the row: stable forever once written.
 *
 * A NULL `published_at` stays NULL — `CASE` returns NULL from the ELSE
 * branch — which keeps undated rows in the `NULLS LAST` bucket the
 * pagination logic already handles explicitly.
 */
function trustedPublishedAt(published: SQL | Column, ingested: SQL | Column) {
  return sql<string | null>`CASE
  WHEN ${published} > ${ingested} THEN ${ingested}
  ELSE ${published}
END`;
}

const EFFECTIVE_PUBLISHED_AT = trustedPublishedAt(rssItems.published_at, rssItems.ingested_at);

/**
 * The same expression bound to the `i` alias used by the hand-written join in
 * `rssItemChunkRepository.vectorSearch`. That query cannot take the Drizzle
 * column refs above (they render table-qualified as `items.…`, not `i.…`), and
 * hand-copying the CASE there would let the two drift apart — so both come out
 * of `trustedPublishedAt` and change together.
 */
export const EFFECTIVE_PUBLISHED_AT_JOINED_ITEM = trustedPublishedAt(
  sql`i.published_at`,
  sql`i.ingested_at`,
);

/**
 * The list projection: everything except the two potentially-huge body
 * columns (`content_text` / `content_text_en`, up to 200 KB each) and
 * `llm_labels`. The detail endpoint fetches those for one row.
 *
 * The translation columns ARE included: the news list renders each card's
 * headline and summary, and for a non-English item those have to be the
 * English rendering — a card showing a Japanese headline is unreadable, and
 * fetching the translation per card would be exactly the client-side request
 * fan-out this repo's performance rules forbid.
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
  published_at: EFFECTIVE_PUBLISHED_AT.as('published_at'),
  ingested_at: rssItems.ingested_at,
  relevance: rssItems.relevance,
  relevance_score: rssItems.relevance_score,
  content_status: rssItems.content_status,
  language: rssItems.language,
  translation_status: rssItems.translation_status,
  title_en: rssItems.title_en,
  summary_en: rssItems.summary_en,
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
      //
      // The non-null branch below OR's in `published_at IS NULL`: the row
      // comparison `(published_at, id) < (cursor_ts, cursor_id)` is a
      // Postgres row comparison, which evaluates to NULL — i.e. excluded —
      // whenever the row's published_at is NULL. Since `ORDER BY
      // published_at DESC NULLS LAST` sorts every undated row after every
      // dated row regardless of the dated cursor's position, the undated
      // bucket must be admitted unconditionally once we're paging past the
      // dated rows, or every undated item becomes permanently unreachable
      // the moment a reader pages past the last dated row.
      conditions.push(
        publishedAt === null
          ? sql`(${EFFECTIVE_PUBLISHED_AT} IS NULL AND ${rssItems.id} < ${id})`
          : sql`((${EFFECTIVE_PUBLISHED_AT}, ${rssItems.id}) < (${publishedAt}::timestamptz, ${id}::uuid) OR ${EFFECTIVE_PUBLISHED_AT} IS NULL)`,
      );
    }

    const limit = clampLimit(filters.limit);
    const query = this.db.select(LIST_COLUMNS).from(rssItems);
    const filtered = conditions.length > 0 ? query.where(and(...conditions)) : query;

    return filtered
      .orderBy(sql`${EFFECTIVE_PUBLISHED_AT} DESC NULLS LAST`, desc(rssItems.id))
      .limit(limit) as Promise<RssItemListRow[]>;
  }

  async findById(id: string): Promise<Tables<'rss_items'> | undefined> {
    const [row] = await this.db
      // Every column, with `published_at` swapped for the trusted expression
      // so the reading pane can't display a date the list already corrected.
      .select({ ...getTableColumns(rssItems), published_at: EFFECTIVE_PUBLISHED_AT.as('published_at') })
      .from(rssItems)
      .where(eq(rssItems.id, id))
      .limit(1);
    return row as Tables<'rss_items'> | undefined;
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
   *
   * `title_en` is searched alongside `title` so an English query can reach a
   * translated foreign-language headline; without it the lexical half was
   * structurally blind to every non-English item in the lake. Both columns
   * have a `gin_trgm_ops` index, so this stays an index scan.
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
        ilike(rssItems.title_en, pattern),
        ilike(rssItems.authors, pattern),
        ilike(rssItems.source_name, pattern),
      )!,
    );

    return this.db
      .select(LIST_COLUMNS)
      .from(rssItems)
      .where(and(...conditions))
      .orderBy(sql`${EFFECTIVE_PUBLISHED_AT} DESC NULLS LAST`, desc(rssItems.id))
      .limit(clampLimit(limit)) as Promise<RssItemListRow[]>;
  }

  /**
   * Distinct facet combinations for the filter bar, in one grouped query
   * rather than a query per category.
   */
  async listFilterOptions(): Promise<RssItemFacet[]> {
    const { rows } = await this.db.execute<{
      category: string;
      source_name: string;
      region: string | null;
    }>(sql`
      SELECT DISTINCT category, source_name, region
      FROM rss.items
      ORDER BY category, source_name
    `);
    return rows;
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
  // Raw `sql` on the left means Drizzle has no column type to bind the ISO
  // string against, so it would go over as untyped text and Postgres would
  // reject `timestamptz >= text`. Cast explicitly, exactly as the keyset
  // cursor above and `rssItemChunkRepository` already do.
  if (filters.from) {
    conditions.push(sql`${EFFECTIVE_PUBLISHED_AT} >= ${filters.from}::timestamptz`);
  }
  if (filters.to) {
    conditions.push(sql`${EFFECTIVE_PUBLISHED_AT} <= ${filters.to}::timestamptz`);
  }
  if (filters.selectedOnly) conditions.push(eq(rssItems.relevance, 'selected'));

  return conditions;
}

export function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}
