import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Parser from 'rss-parser';
import {
  stripHtml,
  itemHash,
  entryTimestamp,
  normalizeEntries,
  isSafeHttpUrl,
  MAX_ITEMS_PER_FEED,
  type FeedRow,
} from './rssNormalize';

const FIXTURES = resolve(__dirname, '../../fixtures');
const parser = new Parser();

const feed: FeedRow = {
  id: 'feed-1',
  category: 'new_funding',
  source_name: 'Sample Wire',
  feed_url: 'https://example.com/rss',
  region: 'US',
  tier: 'curated',
};

describe('stripHtml', () => {
  it('removes tags and collapses non-breaking spaces', () => {
    expect(stripHtml('<p>Acme&nbsp;Corp <b>closed</b></p>')).toBe('Acme Corp  closed');
  });

  it('returns an empty string for undefined input', () => {
    expect(stripHtml(undefined)).toBe('');
  });

  it('truncates to the requested limit', () => {
    expect(stripHtml('a'.repeat(50), 10)).toHaveLength(10);
  });
});

describe('itemHash', () => {
  it('is stable for the same guid', () => {
    expect(itemHash('urn:sample:1')).toBe(itemHash('urn:sample:1'));
  });

  it('differs for different guids', () => {
    expect(itemHash('a')).not.toBe(itemHash('b'));
  });

  it('produces a 64-char hex digest', () => {
    expect(itemHash('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('entryTimestamp', () => {
  it('prefers isoDate', () => {
    expect(entryTimestamp({ isoDate: '2026-09-02T08:30:00.000Z' })).toBe(
      '2026-09-02T08:30:00.000Z',
    );
  });

  it('falls back to parsing pubDate', () => {
    expect(entryTimestamp({ pubDate: 'Tue, 02 Sep 2026 08:30:00 GMT' })).toBe(
      '2026-09-02T08:30:00.000Z',
    );
  });

  it('returns null when there is no usable date', () => {
    expect(entryTimestamp({})).toBeNull();
    expect(entryTimestamp({ pubDate: 'not a date' })).toBeNull();
  });
});

describe('normalizeEntries — RSS 2.0', () => {
  it('maps every entry onto the item shape with feed metadata denormalized', async () => {
    const parsed = await parser.parseString(
      readFileSync(resolve(FIXTURES, 'rss-sample-rss2.xml'), 'utf8'),
    );

    const items = normalizeEntries(feed, parsed, MAX_ITEMS_PER_FEED);

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      feed_id: 'feed-1',
      category: 'new_funding',
      source_name: 'Sample Wire',
      region: 'US',
      feed_tier: 'curated',
      title: 'Acme raises $40m Series B',
      link: 'https://example.com/acme-series-b',
      authors: 'Jane Analyst',
      tags: 'funding; venture',
      published_at: '2026-09-02T08:30:00.000Z',
    });
    expect(items[0].summary).toBe('Acme Corp  closed');
  });

  it('hashes the guid when present and the link when it is not', async () => {
    const parsed = await parser.parseString(
      readFileSync(resolve(FIXTURES, 'rss-sample-rss2.xml'), 'utf8'),
    );

    const items = normalizeEntries(feed, parsed, MAX_ITEMS_PER_FEED);

    expect(items[0].item_hash).toBe(itemHash('urn:sample:1'));
    expect(items[1].item_hash).toBe(itemHash('https://example.com/beta-gamma'));
  });

  it('keeps undated entries rather than dropping them', async () => {
    const parsed = await parser.parseString(
      readFileSync(resolve(FIXTURES, 'rss-sample-rss2.xml'), 'utf8'),
    );

    const items = normalizeEntries(feed, parsed, MAX_ITEMS_PER_FEED);

    expect(items[2].title).toBe('Undated note');
    expect(items[2].published_at).toBeNull();
  });

  it('caps the number of entries taken from one feed', async () => {
    const parsed = await parser.parseString(
      readFileSync(resolve(FIXTURES, 'rss-sample-rss2.xml'), 'utf8'),
    );

    expect(normalizeEntries(feed, parsed, 2)).toHaveLength(2);
  });

  it('drops entries with neither guid nor link, since they cannot be deduped', () => {
    const items = normalizeEntries(
      feed,
      { items: [{ title: 'Ghost' }] },
      MAX_ITEMS_PER_FEED,
    );
    expect(items).toEqual([]);
  });

  it('falls through to the link when guid is present but empty, rather than dropping the item', () => {
    // Some CMS feed generators emit a present-but-empty <guid></guid>, which
    // rss-parser surfaces as guid: '' — not nullish, so a naive `??` chain
    // would short-circuit before ever trying the link.
    const items = normalizeEntries(
      feed,
      { items: [{ title: 'Empty guid', guid: '', link: 'https://example.com/empty-guid' }] },
      MAX_ITEMS_PER_FEED,
    );
    expect(items).toHaveLength(1);
    expect(items[0].item_hash).toBe(itemHash('https://example.com/empty-guid'));
  });

  it('never emits duplicate hashes within a single feed poll', () => {
    const items = normalizeEntries(
      feed,
      {
        items: [
          { title: 'Same', link: 'https://example.com/x' },
          { title: 'Same again', link: 'https://example.com/x' },
        ],
      },
      MAX_ITEMS_PER_FEED,
    );
    expect(items).toHaveLength(1);
  });
});

describe('isSafeHttpUrl', () => {
  it('accepts http and https URLs', () => {
    expect(isSafeHttpUrl('https://example.com/a')).toBe(true);
    expect(isSafeHttpUrl('http://example.com/a')).toBe(true);
  });

  it('rejects a javascript: URL', () => {
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects a data: URL', () => {
    expect(isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects an unparseable string', () => {
    expect(isSafeHttpUrl('not a url')).toBe(false);
  });
});

describe('normalizeEntries — malicious link schemes', () => {
  it('drops an entry whose link is a javascript: URL, even with a stable guid', () => {
    const items = normalizeEntries(
      feed,
      {
        items: [
          {
            title: 'Malicious',
            guid: 'urn:sample:malicious',
            link: 'javascript:alert(document.cookie)',
          },
        ],
      },
      MAX_ITEMS_PER_FEED,
    );
    expect(items).toEqual([]);
  });

  it('drops an entry whose link is a data: URL', () => {
    const items = normalizeEntries(
      feed,
      {
        items: [
          {
            title: 'Malicious data URL',
            guid: 'urn:sample:malicious-data',
            link: 'data:text/html,<script>alert(1)</script>',
          },
        ],
      },
      MAX_ITEMS_PER_FEED,
    );
    expect(items).toEqual([]);
  });

  it('keeps an entry with an ordinary https link', () => {
    const items = normalizeEntries(
      feed,
      { items: [{ title: 'Fine', guid: 'urn:sample:fine', link: 'https://example.com/fine' }] },
      MAX_ITEMS_PER_FEED,
    );
    expect(items).toHaveLength(1);
    expect(items[0].link).toBe('https://example.com/fine');
  });
});

describe('normalizeEntries — Atom', () => {
  it('reads Atom link/id/updated/author', async () => {
    const parsed = await parser.parseString(
      readFileSync(resolve(FIXTURES, 'rss-sample-atom.xml'), 'utf8'),
    );

    const items = normalizeEntries(
      { ...feed, category: 'industry_reports', source_name: 'Sample Atom Research' },
      parsed,
      MAX_ITEMS_PER_FEED,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: 'Initiating coverage on Delta Industries',
      link: 'https://example.com/delta-initiation',
      published_at: '2026-09-02T06:00:00.000Z',
      category: 'industry_reports',
    });
    expect(items[0].summary).toBe('We initiate at Buy.');
  });
});
