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
          ? sql`(${rssItems.published_at} IS NULL AND ${rssItems.id} < ${id})`
          : sql`((${rssItems.published_at}, ${rssItems.id}) < (${publishedAt}::timestamptz, ${id}::uuid) OR ${rssItems.published_at} IS NULL)`,
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
  if (filters.from) conditions.push(gte(rssItems.published_at, filters.from));
  if (filters.to) conditions.push(lte(rssItems.published_at, filters.to));
  if (filters.selectedOnly) conditions.push(eq(rssItems.relevance, 'selected'));

  return conditions;
}

export function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}
