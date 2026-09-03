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
  return text
    .replace(TAG_RE, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/ /g, ' ')
    .trim()
    .slice(0, limit);
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

/**
 * Whether `link` is safe to later render as an anchor's `href` unescaped.
 * Only `http:`/`https:` qualify — a feed can put anything in `<link>`,
 * including `javascript:` or `data:` URIs, which would otherwise become a
 * script/phishing navigation when a client renders "Read original".
 */
export function isSafeHttpUrl(link: string): boolean {
  try {
    const parsed = new URL(link);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
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
    // A non-http(s) link (javascript:, data:, ...) is consistent with "no
    // stable identity" below: never store it, since it would eventually be
    // rendered as-is as the "Read original" href.
    if (link && !isSafeHttpUrl(link)) continue;
    // Deliberately `||`, not `??`: several CMS feed generators emit a
    // present-but-empty `<guid></guid>` (parses to `guid: ''`), which is not
    // nullish and would short-circuit `??` before ever trying `id`/`link`.
    // Do not "modernise" this back to `??` — it would silently drop items.
    const guid = (item.guid || item.id || link).trim();
    // No stable identity means no dedupe key — skip rather than invent one.
    if (!guid) continue;

    const hash = itemHash(guid);
    if (seen.has(hash)) continue;
    seen.add(hash);

    // Prefer the raw HTML fields (`content` for RSS 2.0, `summary` for Atom)
    // over rss-parser's own pre-stripped `contentSnippet` — running our
    // stripHtml over the raw markup preserves tag-boundary whitespace that
    // rss-parser's snippet already collapsed away.
    const summary = stripHtml(item.content ?? item.summary ?? item.contentSnippet);
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
