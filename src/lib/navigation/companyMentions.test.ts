import { describe, expect, it } from 'vitest';
import {
  COMPANY_MENTIONS_MARKER,
  COMPANY_MENTIONS_PROMPT_GUIDE,
  buildCompanyMentionsMarker,
  parseCompanyMentions,
  selectMentionedCompanies,
  stripCompanyMentionMarkers,
} from './companyMentions';

describe('buildCompanyMentionsMarker', () => {
  it('round-trips through the parser', () => {
    const companies = [
      { id: 'c-acme', name: 'Acme Corp' },
      { id: 'c-cinder', name: 'Cinder Foods' },
    ];
    expect(parseCompanyMentions(buildCompanyMentionsMarker(companies))).toEqual(companies);
  });

  it('returns an empty string when there is nothing to emit', () => {
    expect(buildCompanyMentionsMarker([])).toBe('');
    expect(buildCompanyMentionsMarker([{ id: '', name: 'Acme' }])).toBe('');
    expect(buildCompanyMentionsMarker([{ id: 'c-1', name: '   ' }])).toBe('');
  });

  it('trims names', () => {
    const marker = buildCompanyMentionsMarker([{ id: 'c-1', name: '  Acme Corp  ' }]);
    expect(parseCompanyMentions(marker)).toEqual([{ id: 'c-1', name: 'Acme Corp' }]);
  });
});

describe('parseCompanyMentions', () => {
  it('returns [] for content with no marker', () => {
    expect(parseCompanyMentions('A plain markdown table.')).toEqual([]);
  });

  it('skips a malformed manifest instead of throwing', () => {
    expect(parseCompanyMentions(`<!-- ${COMPANY_MENTIONS_MARKER}:{not json} -->`)).toEqual([]);
  });

  it('skips a manifest that is not an array', () => {
    expect(parseCompanyMentions(`<!-- ${COMPANY_MENTIONS_MARKER}:{"id":"c-1"} -->`)).toEqual([]);
  });

  it('skips entries missing an id or name', () => {
    const marker = `<!-- ${COMPANY_MENTIONS_MARKER}:${JSON.stringify([
      { id: 'c-1', name: 'Keep Me' },
      { id: 'c-2' },
      { name: 'No Id' },
      { id: 42, name: 'Wrong Type' },
    ])} -->`;
    expect(parseCompanyMentions(marker)).toEqual([{ id: 'c-1', name: 'Keep Me' }]);
  });

  it('collects across several markers in one output', () => {
    const combined =
      buildCompanyMentionsMarker([{ id: 'c-1', name: 'One' }]) +
      '\n' +
      buildCompanyMentionsMarker([{ id: 'c-2', name: 'Two' }]);
    expect(parseCompanyMentions(combined).map((c) => c.id)).toEqual(['c-1', 'c-2']);
  });
});

describe('stripCompanyMentionMarkers', () => {
  it('removes the marker and the whitespace ahead of it', () => {
    const content = `| Acme | L1 |\n\n${buildCompanyMentionsMarker([{ id: 'c-1', name: 'Acme' }])}`;
    expect(stripCompanyMentionMarkers(content)).toBe('| Acme | L1 |');
  });

  it('leaves unrelated content untouched', () => {
    expect(stripCompanyMentionMarkers('No markers here.')).toBe('No markers here.');
  });
});

describe('selectMentionedCompanies', () => {
  const acme = { id: 'c-acme', name: 'Acme Corp' };
  const cinder = { id: 'c-cinder', name: 'Cinder Foods' };
  const halcyon = { id: 'c-halcyon', name: 'Halcyon Media' };

  // The whole point: a 50-row table must not produce 50 chips.
  it('keeps only the companies the assistant actually named', () => {
    const result = selectMentionedCompanies(
      [acme, cinder, halcyon],
      'Of those, only Acme Corp clears the L1 bar.',
    );
    expect(result).toEqual([acme]);
  });

  it('orders by first mention, not by manifest order', () => {
    const result = selectMentionedCompanies(
      [acme, cinder, halcyon],
      'Halcyon Media looks strongest, then Acme Corp.',
    );
    expect(result.map((c) => c.id)).toEqual(['c-halcyon', 'c-acme']);
  });

  it('matches case-insensitively', () => {
    expect(selectMentionedCompanies([acme], 'acme corp is interesting')).toEqual([acme]);
  });

  // "Acme" must not light up inside "Acmetric".
  it('requires a word boundary', () => {
    expect(selectMentionedCompanies([{ id: 'c-1', name: 'Acme' }], 'Acmetric Holdings')).toEqual(
      [],
    );
    expect(selectMentionedCompanies([{ id: 'c-1', name: 'Acme' }], 'We like Acme.')).toHaveLength(
      1,
    );
  });

  it('matches a name at the very start or end of the text', () => {
    expect(selectMentionedCompanies([acme], 'Acme Corp')).toEqual([acme]);
  });

  it('treats a name with regex characters literally', () => {
    const odd = { id: 'c-odd', name: 'A+B (Holdings)' };
    expect(selectMentionedCompanies([odd], 'We reviewed A+B (Holdings) today.')).toEqual([odd]);
    expect(selectMentionedCompanies([odd], 'We reviewed AXB Holdings today.')).toEqual([]);
  });

  // A company can arrive under both its target and project name.
  it('dedupes by id, keeping the longer name', () => {
    const result = selectMentionedCompanies(
      [
        { id: 'c-acme', name: 'Acme' },
        { id: 'c-acme', name: 'Acme Corporation' },
      ],
      'Acme Corporation, also tracked as Acme, is progressing.',
    );
    expect(result).toEqual([{ id: 'c-acme', name: 'Acme Corporation' }]);
  });

  it('returns [] for empty inputs', () => {
    expect(selectMentionedCompanies([], 'Acme Corp')).toEqual([]);
    expect(selectMentionedCompanies([acme], '')).toEqual([]);
    expect(selectMentionedCompanies([acme], '   ')).toEqual([]);
  });
});

/**
 * The prompt guidance and the matcher are one mechanism. These assert the
 * advice the model is given actually produces chips, so the two cannot drift
 * apart silently — a change to the matching rules should break these first.
 */
describe('COMPANY_MENTIONS_PROMPT_GUIDE', () => {
  const cohort = [
    { id: 'c1', name: 'Acme Chemicals' },
    { id: 'c2', name: 'Toyo Materials' },
    { id: 'c3', name: 'Nippon Fine Products' },
  ];

  // The block's central claim: a bare aggregate is a dead end, and naming the
  // companies is what turns the same summary into something clickable.
  it('is right that an unnamed summary produces no chips', () => {
    const summary = '12 active deals at L1, mostly Japanese industrials.';
    expect(selectMentionedCompanies(cohort, summary)).toEqual([]);
  });

  it('is right that its own rewritten summary chips every company it names', () => {
    const summary =
      '12 active deals at L1, mostly Japanese industrials — the largest are ' +
      'Acme Chemicals, Toyo Materials and Nippon Fine Products.';
    expect(selectMentionedCompanies(cohort, summary)).toEqual(cohort);
  });

  // The block tells the model "Acme Chemicals" links but "Acme" does not.
  it('is right that a prefix of a name does not chip', () => {
    expect(selectMentionedCompanies(cohort, 'Acme is progressing.')).toEqual([]);
    expect(selectMentionedCompanies(cohort, 'Acme Chemicals is progressing.')).toEqual([
      cohort[0],
    ]);
  });

  it('states the rules it relies on, so the advice stays self-contained', () => {
    for (const claim of ['query_companies', 'get_company_stats', 'summaries']) {
      expect(COMPANY_MENTIONS_PROMPT_GUIDE).toContain(claim);
    }
  });
});
