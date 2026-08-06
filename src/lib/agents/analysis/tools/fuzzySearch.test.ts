import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MATCH_THRESHOLD,
  canonicalName,
  diceCoefficient,
  fuzzySearch,
  levenshtein,
  matchLabel,
  nameScore,
  normalizeName,
  tokenize,
} from './fuzzySearch';

describe('normalizeName', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeName('  Acme,  Holdings—Inc.  ')).toBe('acme holdings inc');
  });

  it('expands ampersands into a word so "A&B" and "A and B" agree', () => {
    expect(normalizeName('Smith & Wesson')).toBe('smith and wesson');
  });

  it('strips diacritics', () => {
    expect(normalizeName('Crédit Agricole')).toBe('credit agricole');
  });

  it('returns an empty string for null/undefined', () => {
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
  });
});

describe('tokenize', () => {
  it('drops trailing legal-form suffixes', () => {
    expect(tokenize('Acme Holdings Pte Ltd')).toEqual(['acme', 'holdings']);
    expect(tokenize('Beta Industries, Inc.')).toEqual(['beta', 'industries']);
  });

  it('keeps domain words like fund, capital, and partners', () => {
    expect(tokenize('Growth Fund II')).toEqual(['growth', 'fund', 'ii']);
    expect(tokenize('Meridian Capital Partners')).toEqual(['meridian', 'capital', 'partners']);
  });

  it('never strips every token', () => {
    expect(tokenize('Ltd')).toEqual(['ltd']);
  });
});

describe('nameScore', () => {
  it('scores an identical name 1', () => {
    expect(nameScore('Acme Holdco', 'acme holdco')).toBe(1);
  });

  it('treats a legal-suffix variant as an exact match', () => {
    expect(nameScore('Acme Holdings', 'Acme Holdings Pte Ltd')).toBe(1);
  });

  it('scores a prefix higher than a mid-string substring', () => {
    expect(nameScore('acme', 'Acme Holdco')).toBeGreaterThan(
      nameScore('holdco', 'Acme Holdco Group'),
    );
  });

  it('matches when the query has all the name words out of order', () => {
    expect(nameScore('holdings acme', 'Acme Holdings')).toBeGreaterThanOrEqual(0.85);
  });

  it('resolves acronyms to multi-word names', () => {
    expect(nameScore('GF', 'Growth Fund')).toBeGreaterThanOrEqual(DEFAULT_MATCH_THRESHOLD);
  });

  it('tolerates a typo', () => {
    expect(nameScore('Acne Holdco', 'Acme Holdco')).toBeGreaterThanOrEqual(
      DEFAULT_MATCH_THRESHOLD,
    );
  });

  it('scores unrelated names below the threshold', () => {
    expect(nameScore('Acme', 'Zenith Logistics')).toBeLessThan(DEFAULT_MATCH_THRESHOLD);
  });

  it('does not let a 2-character query match everything by containment', () => {
    expect(nameScore('co', 'Zenith Logistics Co')).toBeLessThan(DEFAULT_MATCH_THRESHOLD);
  });

  it('returns 0 when either side is empty', () => {
    expect(nameScore('', 'Acme')).toBe(0);
    expect(nameScore('Acme', null)).toBe(0);
  });
});

describe('diceCoefficient', () => {
  it('returns 1 for identical strings and 0 for no shared bigrams', () => {
    expect(diceCoefficient('acme', 'acme')).toBe(1);
    expect(diceCoefficient('acme', 'zzzz')).toBe(0);
  });
});

describe('levenshtein', () => {
  it('counts single-character edits', () => {
    expect(levenshtein('acme', 'acne')).toBe(1);
    expect(levenshtein('acme', '')).toBe(4);
    expect(levenshtein('acme', 'acme')).toBe(0);
  });
});

describe('fuzzySearch', () => {
  const items = [
    { id: '1', name: 'Acme Holdings Pte Ltd', legal: 'Acme Holdings Private Limited' },
    { id: '2', name: 'Growth Fund II', legal: null },
    { id: '3', name: 'Zenith Logistics', legal: null },
  ];
  const names = (i: (typeof items)[number]) => [i.name, i.legal];

  it('ranks the best match first and drops non-matches', () => {
    const hits = fuzzySearch('acme', items, names);

    expect(hits).toHaveLength(1);
    expect(hits[0].item.id).toBe('1');
    expect(hits[0].matchedOn).toBe('Acme Holdings Pte Ltd');
  });

  it('matches on a secondary name field', () => {
    const hits = fuzzySearch('Acme Holdings Private', items, names);

    expect(hits[0].item.id).toBe('1');
    expect(hits[0].matchedOn).toBe('Acme Holdings Private Limited');
  });

  it('returns [] when nothing clears the threshold', () => {
    expect(fuzzySearch('nonexistent target', items, names)).toEqual([]);
  });

  it('honours the limit', () => {
    const hits = fuzzySearch('fund', [...items, { id: '4', name: 'Fund I', legal: null }], names, {
      limit: 1,
    });

    expect(hits).toHaveLength(1);
  });

  it('honours a custom threshold', () => {
    const strict = fuzzySearch('growth fnd', items, names, { threshold: 0.99 });

    expect(strict).toEqual([]);
  });

  it('skips null and empty name fields without throwing', () => {
    const hits = fuzzySearch('growth', [{ id: '9', name: null, legal: undefined }], (i) => [
      i.name,
      i.legal,
    ]);

    expect(hits).toEqual([]);
  });
});

describe('matchLabel', () => {
  it('maps scores onto strength labels', () => {
    expect(matchLabel(1)).toBe('exact');
    expect(matchLabel(0.9)).toBe('strong');
    expect(matchLabel(0.75)).toBe('partial');
    expect(matchLabel(0.55)).toBe('weak');
  });
});

describe('canonicalName', () => {
  it('joins the suffix-stripped tokens back into a comparison string', () => {
    expect(canonicalName('Acme Holdings, Pte. Ltd.')).toBe('acme holdings');
  });
});
