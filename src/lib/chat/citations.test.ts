import { describe, it, expect } from 'vitest';
import {
  CITATION_GROUP_PROP,
  STALE_SOURCE_MONTHS,
  hostOf,
  inlineCitationsOf,
  isStaleSource,
  parseCitationLabel,
  parseSourceDate,
  readCitationGroup,
  readPublishedDate,
  remarkCitationGroups,
} from './citations';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe('parseSourceDate', () => {
  it('reads the date shapes a reply may use', () => {
    expect(parseSourceDate('12 Mar 2026')).toEqual(utc(2026, 3, 12));
    expect(parseSourceDate('12 March 2026')).toEqual(utc(2026, 3, 12));
    expect(parseSourceDate('Mar 12, 2026')).toEqual(utc(2026, 3, 12));
    expect(parseSourceDate('2026-03-12')).toEqual(utc(2026, 3, 12));
    expect(parseSourceDate('Mar 2026')).toEqual(utc(2026, 3, 1));
    expect(parseSourceDate('2026')).toEqual(utc(2026, 1, 1));
    expect(parseSourceDate('last week')).toBeNull();
  });
});

describe('parseCitationLabel', () => {
  it('splits a citation into its source and date', () => {
    expect(parseCitationLabel('Reuters, 12 Mar 2026')).toEqual({
      source: 'Reuters',
      dateText: '12 Mar 2026',
      date: utc(2026, 3, 12),
    });
    expect(parseCitationLabel('Bank Indonesia, Q1 report, Mar 12, 2026')).toEqual({
      source: 'Bank Indonesia, Q1 report',
      dateText: 'Mar 12, 2026',
      date: utc(2026, 3, 12),
    });
    expect(parseCitationLabel('Company site, undated')).toEqual({ source: 'Company site', dateText: 'undated', date: null });
    expect(parseCitationLabel('Reuters, 12 Mar 2024 · dated')?.dateText).toBe('12 Mar 2024');
  });

  it('leaves an ordinary link alone', () => {
    expect(parseCitationLabel('the filing')).toBeNull();
    expect(parseCitationLabel('Smith, Jones and Co')).toBeNull();
    expect(parseCitationLabel('Smith, 2024')).toBeNull();
    expect(parseCitationLabel('https://example.com')).toBeNull();
  });

  it('still treats a year-only citation as dated when the source is not a lone name', () => {
    expect(parseCitationLabel('Annual report, 2024')?.dateText).toBe('2024');
  });
});

describe('isStaleSource', () => {
  const now = utc(2026, 10, 15);
  it(`flags a source older than ${STALE_SOURCE_MONTHS} months`, () => {
    expect(isStaleSource(utc(2025, 10, 16), now, 12)).toBe(false);
    expect(isStaleSource(utc(2025, 10, 14), now, 12)).toBe(true);
    expect(isStaleSource(utc(2026, 5, 1), now, 3)).toBe(true);
  });
});

describe('readPublishedDate', () => {
  it("labels a search result's date, and ignores one it cannot read", () => {
    expect(readPublishedDate('2026-03-12')).toEqual({ label: '12 Mar 2026', date: utc(2026, 3, 12) });
    expect(readPublishedDate('2026-03-12T08:30:00Z')?.label).toBe('12 Mar 2026');
    expect(readPublishedDate('sometime')).toBeNull();
    expect(readPublishedDate(undefined)).toBeNull();
  });
});

describe('hostOf', () => {
  it('names a source by its host when the link carries no headline', () => {
    expect(hostOf('https://www.reuters.com/markets/x')).toBe('reuters.com');
    expect(hostOf('not a url')).toBe('not a url');
  });
});

describe('remarkCitationGroups', () => {
  const link = (text: string, url: string, title: string | null = null) => ({
    type: 'link',
    url,
    title,
    children: [{ type: 'text', value: text }],
  });

  it('carries each source with its headline, or its host when there is none, as JSON on one cite', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'text', value: 'Fact (' },
            link('Reuters, 12 Mar 2026', 'https://www.reuters.com/a', 'Nickel output jumps'),
            { type: 'text', value: '; ' },
            link('Bloomberg, undated', 'https://bloomberg.com/b'),
            { type: 'text', value: ').' },
          ],
        },
      ],
    };
    remarkCitationGroups()(tree);

    const para = tree.children[0].children as { type: string; value?: string; data?: { hName: string; hProperties: Record<string, string> } }[];
    expect(para.map((n) => n.type)).toEqual(['text', 'citationGroup', 'text']);
    expect(para[0].value).toBe('Fact');
    expect(para[2].value).toBe('.');
    expect(para[1].data?.hName).toBe('cite');
    expect(readCitationGroup(para[1].data?.hProperties[CITATION_GROUP_PROP])).toEqual([
      { source: 'Reuters', dateText: '12 Mar 2026', date: '2026-03-12T00:00:00.000Z', url: 'https://www.reuters.com/a', title: 'Nickel output jumps' },
      { source: 'Bloomberg', dateText: 'undated', date: null, url: 'https://bloomberg.com/b', title: 'bloomberg.com' },
    ]);
  });

  it('reads a malformed group as no sources rather than throwing', () => {
    expect(readCitationGroup('{oops')).toEqual([]);
    expect(readCitationGroup(undefined)).toEqual([]);
    expect(readCitationGroup('{"a":1}')).toEqual([]);
  });
});

describe('inlineCitationsOf', () => {
  it('lists the sources an answer cites, once each, with headline and date', () => {
    const md = [
      'A ([Reuters, 12 Mar 2026](https://r.example/a "Nickel jumps")).',
      'B ([Reuters, 12 Mar 2026](https://r.example/a "Nickel jumps"); [Bloomberg, undated](https://www.bloomberg.com/b)).',
      'See [the filing](https://sec.example) and [VNR list (Dan Tri, 24 Oct 2026)](https://dantri.example).',
    ].join('\n');
    expect(inlineCitationsOf(md)).toEqual([
      { title: 'Nickel jumps', url: 'https://r.example/a', published: '2026-03-12' },
      { title: 'bloomberg.com', url: 'https://www.bloomberg.com/b' },
      { title: 'dantri.example', url: 'https://dantri.example', published: '2026-10-24' },
    ]);
  });
});
