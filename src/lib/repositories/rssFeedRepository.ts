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
   *
   * Postgres rejects a single `INSERT ... ON CONFLICT DO UPDATE` statement
   * that contains two rows sharing the same conflict key ("ON CONFLICT DO
   * UPDATE command cannot affect row a second time"), and the real feed
   * catalog genuinely contains duplicate `feed_url` values. So incoming rows
   * are de-duplicated by `feed_url` first, keeping the last occurrence.
   */
  async bulkUpsert(rows: RssFeedInput[]): Promise<number> {
    if (rows.length === 0) return 0;
    const deduped = dedupeByFeedUrl(rows);
    const affected = await this.db
      .insert(rssFeeds)
      .values(deduped.map(withDefaults))
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

/** De-duplicates by `feed_url`, keeping the last occurrence for each key. */
function dedupeByFeedUrl(rows: RssFeedInput[]): RssFeedInput[] {
  const byUrl = new Map<string, RssFeedInput>();
  for (const row of rows) {
    byUrl.set(row.feed_url, row);
  }
  return Array.from(byUrl.values());
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
