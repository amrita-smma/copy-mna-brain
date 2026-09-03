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
 *
 * Parsed via `URL` rather than a single regex over the raw string — a regex
 * anchored on `(^|\.)` never matches a real `https://news.google.com/...`
 * URL, since the character right before the hostname is `/`, not `^` or `.`.
 */
function inferTier(feedUrl: string): RssFeedTier {
  try {
    const { hostname, pathname } = new URL(feedUrl);
    if (hostname === 'news.google.com' || hostname.endsWith('.news.google.com')) {
      return 'query';
    }
    if (
      (hostname === 'bing.com' || hostname.endsWith('.bing.com')) &&
      pathname.startsWith('/news')
    ) {
      return 'query';
    }
  } catch {
    // Malformed URL — fall through to the default below.
  }
  return 'curated';
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
