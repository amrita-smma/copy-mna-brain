import { describe, expect, it } from 'vitest';
import { buildLedgerIndex } from './derive';
import {
  describeFilter,
  filterTextValue,
  hasFilter,
  isNumericColumn,
  isPartyColumn,
  matchesFilter,
  passesFilters,
  type LedgerFilter,
} from './filters';
import { ENTRIES, buildTestPortfolio } from './testFixtures';

const index = buildLedgerIndex(buildTestPortfolio());

const filter = (parts: Omit<LedgerFilter, 'id'>): LedgerFilter => ({ id: 'f1', ...parts });

describe('filterTextValue', () => {
  it('returns the same string the cell shows, so a right-click always matches', () => {
    expect(filterTextValue(ENTRIES.gotoBuy, 'date', index)).toBe('22/01/18');
    expect(filterTextValue(ENTRIES.gotoBuy, 'type', index)).toBe('Buy');
    expect(filterTextValue(ENTRIES.gotoBuy, 'holder', index)).toBe(
      'Meranti Global Investment Ltd',
    );
    expect(filterTextValue(ENTRIES.gotoBuy, 'instrument', index)).toBe('GOTO Group');
    expect(filterTextValue(ENTRIES.gotoBuy, 'source', index)).toBe('DCA');
    expect(filterTextValue(ENTRIES.gotoBuy, 'description', index)).toBe(
      'Investment — GOTO Group Series E',
    );
    expect(filterTextValue(ENTRIES.gotoBuy, 'subType', index)).toBe('initial');
  });

  it('reads From and To off the derived direction of travel', () => {
    expect(filterTextValue(ENTRIES.gotoBuy, 'from', index)).toBe(
      'Meranti Global Investment Ltd',
    );
    expect(filterTextValue(ENTRIES.gotoBuy, 'to', index)).toBe('GOTO Group');
    expect(filterTextValue(ENTRIES.distribution, 'from', index)).toBe(
      'Startech Growth Fund VCC',
    );
  });

  it('spells the data status out rather than exposing the enum', () => {
    expect(filterTextValue(ENTRIES.subscription1982, 'status', index)).toBe('Needs checking');
    expect(filterTextValue(ENTRIES.gotoBuy, 'status', index)).toBe('Verified');
  });

  it('returns an empty string when a row touches no pool at all', () => {
    expect(filterTextValue(ENTRIES.distribution, 'source', index)).toBe('');
  });

  it('lists every pool a row touches, not just the declared one', () => {
    // Akulaku is funded jointly, so the split lives on the entry.
    expect(filterTextValue(ENTRIES.akulakuBuy, 'source', index)).toBe(
      'Aldiracita + Hawthorn',
    );
  });

  it('returns null for the numeric columns, which are not compared as text', () => {
    expect(filterTextValue(ENTRIES.gotoBuy, 'cash', index)).toBeNull();
    expect(filterTextValue(ENTRIES.gotoBuy, 'price', index)).toBeNull();
    expect(filterTextValue(ENTRIES.gotoBuy, 'valuation', index)).toBeNull();
  });
});

describe('column classification', () => {
  it('separates numeric columns from text ones', () => {
    expect(isNumericColumn('cash')).toBe(true);
    expect(isNumericColumn('quantity')).toBe(true);
    expect(isNumericColumn('valuation')).toBe(true);
    expect(isNumericColumn('type')).toBe(false);
  });

  it('marks the columns that name a party', () => {
    expect(isPartyColumn('from')).toBe(true);
    expect(isPartyColumn('holder')).toBe(true);
    expect(isPartyColumn('source')).toBe(false);
  });
});

describe('matchesFilter', () => {
  it('matches exactly on "is" and inverts it on "not"', () => {
    expect(matchesFilter(ENTRIES.gotoBuy, filter({ column: 'type', operator: 'is', value: 'Buy' }), index)).toBe(true);
    expect(matchesFilter(ENTRIES.distribution, filter({ column: 'type', operator: 'is', value: 'Buy' }), index)).toBe(false);
    expect(matchesFilter(ENTRIES.distribution, filter({ column: 'type', operator: 'not', value: 'Buy' }), index)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesFilter(ENTRIES.gotoBuy, filter({ column: 'type', operator: 'is', value: 'buy' }), index)).toBe(true);
  });

  it('does a substring match on "includes"', () => {
    expect(matchesFilter(ENTRIES.gotoBuy, filter({ column: 'description', operator: 'includes', value: 'GOTO' }), index)).toBe(true);
    expect(matchesFilter(ENTRIES.gotoBuy, filter({ column: 'description', operator: 'includes', value: 'Akulaku' }), index)).toBe(false);
  });

  it('matches "involves" on either side of the movement', () => {
    const involvesGoto = filter({ column: 'from', operator: 'involves', value: 'GOTO Group' });
    // GOTO is the instrument, not the holder — "involves" still finds it.
    expect(matchesFilter(ENTRIES.gotoBuy, involvesGoto, index)).toBe(true);
    expect(matchesFilter(ENTRIES.akulakuBuy, involvesGoto, index)).toBe(false);
  });

  it('matches "involves" on the far leg of a transfer', () => {
    // SMMA holds one leg; the other names it only as the counterparty.
    const involvesSmma = filter({
      column: 'holder',
      operator: 'involves',
      value: 'PT Sinar Mas Multiartha Tbk',
    });
    expect(matchesFilter(ENTRIES.transferGive, involvesSmma, index)).toBe(true);
  });

  it('matches a single pool that only appears in a funding split', () => {
    // Picking "Aldiracita" in the entity search produces exactly this filter.
    // It must find the Akulaku row, whose position declares no source and names
    // the pool only in its split — otherwise the search says "1 row" and the
    // sheet then shows none.
    const aldiracita = filter({ column: 'source', operator: 'is', value: 'Aldiracita' });
    expect(matchesFilter(ENTRIES.akulakuBuy, aldiracita, index)).toBe(true);
    expect(matchesFilter(ENTRIES.gotoBuy, aldiracita, index)).toBe(false);
  });

  it('matches a pool declared on the position', () => {
    const dca = filter({ column: 'source', operator: 'is', value: 'DCA' });
    expect(matchesFilter(ENTRIES.gotoBuy, dca, index)).toBe(true);
    expect(matchesFilter(ENTRIES.akulakuBuy, dca, index)).toBe(false);
  });

  it('matches the whole multi-pool cell too, so right-clicking it works', () => {
    const both = filter({
      column: 'source',
      operator: 'is',
      value: 'Aldiracita + Hawthorn',
    });
    expect(matchesFilter(ENTRIES.akulakuBuy, both, index)).toBe(true);
  });

  it('excludes every row touching the pool on "not"', () => {
    const notAldiracita = filter({ column: 'source', operator: 'not', value: 'Aldiracita' });
    expect(matchesFilter(ENTRIES.akulakuBuy, notAldiracita, index)).toBe(false);
    expect(matchesFilter(ENTRIES.gotoBuy, notAldiracita, index)).toBe(true);
  });

  it('applies the numeric operators to the signed figure', () => {
    const cashBelowZero = filter({ column: 'cash', operator: 'below_zero', value: '' });
    const cashAboveZero = filter({ column: 'cash', operator: 'above_zero', value: '' });
    expect(matchesFilter(ENTRIES.gotoBuy, cashBelowZero, index)).toBe(true);
    expect(matchesFilter(ENTRIES.gotoBuy, cashAboveZero, index)).toBe(false);
    expect(matchesFilter(ENTRIES.distribution, cashAboveZero, index)).toBe(true);
  });

  it('treats a zero delta as having no value', () => {
    const hasCash = filter({ column: 'cash', operator: 'has_value', value: '' });
    expect(matchesFilter(ENTRIES.commitment, hasCash, index)).toBe(false);
    expect(matchesFilter(ENTRIES.gotoBuy, hasCash, index)).toBe(true);
  });

  it('does not treat a signed zero as negative', () => {
    // "-0.00000000" is zero, and an outflow filter must not pick it up.
    const signedZero = { ...ENTRIES.commitment, cash_delta: '-0.00000000' };
    expect(matchesFilter(signedZero, filter({ column: 'cash', operator: 'below_zero', value: '' }), index)).toBe(false);
    expect(matchesFilter(signedZero, filter({ column: 'cash', operator: 'has_value', value: '' }), index)).toBe(false);
  });

  it('applies the numeric operators to an adjustment valuation delta', () => {
    // A write-off carries its whole amount here and nothing in cash, so a
    // cash-based filter can never find it.
    const writeOff = { ...ENTRIES.commitment, valuation_delta: '-914781.37000000' };
    const below = filter({ column: 'valuation', operator: 'below_zero', value: '' });
    const has = filter({ column: 'valuation', operator: 'has_value', value: '' });
    expect(matchesFilter(writeOff, below, index)).toBe(true);
    expect(matchesFilter(writeOff, has, index)).toBe(true);
    expect(matchesFilter(ENTRIES.commitment, has, index)).toBe(false);
  });

  it('filters on the derived price when the row recorded none', () => {
    const priced = filter({ column: 'price', operator: 'has_value', value: '' });
    expect(matchesFilter(ENTRIES.gotoBuy, priced, index)).toBe(true);
    // A commitment has neither units nor cash, so it has no price at all.
    expect(matchesFilter(ENTRIES.commitment, priced, index)).toBe(false);
  });

  it('never matches a numeric operator applied to a text column', () => {
    expect(matchesFilter(ENTRIES.gotoBuy, filter({ column: 'type', operator: 'above_zero', value: '' }), index)).toBe(false);
  });
});

describe('passesFilters', () => {
  it('requires every filter to match', () => {
    const filters: LedgerFilter[] = [
      { id: 'a', column: 'type', operator: 'is', value: 'Buy' },
      { id: 'b', column: 'source', operator: 'is', value: 'DCA' },
    ];
    expect(passesFilters(ENTRIES.gotoBuy, filters, index)).toBe(true);
    // Akulaku is a buy, but its position declares no source.
    expect(passesFilters(ENTRIES.akulakuBuy, filters, index)).toBe(false);
  });

  it('passes everything when nothing is filtered', () => {
    expect(passesFilters(ENTRIES.gotoBuy, [], index)).toBe(true);
  });
});

describe('describeFilter', () => {
  it('reads From and To without the redundant "is"', () => {
    expect(describeFilter(filter({ column: 'from', operator: 'is', value: 'SMMA' }))).toEqual({
      prefix: 'From',
      value: 'SMMA',
    });
  });

  it('spells out the other operators', () => {
    expect(describeFilter(filter({ column: 'type', operator: 'is', value: 'Buy' })).prefix).toBe('Type is');
    expect(describeFilter(filter({ column: 'type', operator: 'not', value: 'Buy' })).prefix).toBe('Type not');
    expect(describeFilter(filter({ column: 'description', operator: 'includes', value: 'GOTO' })).prefix).toBe('Description includes');
    expect(describeFilter(filter({ column: 'holder', operator: 'involves', value: 'SMMA' })).prefix).toBe('Involves');
  });

  it('drops the value for the operators that take none', () => {
    expect(describeFilter(filter({ column: 'cash', operator: 'below_zero', value: '' }))).toEqual({
      prefix: 'Cash Δ is below zero',
      value: '',
    });
  });

  it('prefers the display string when the raw value is an id', () => {
    const chip = describeFilter(
      filter({ column: 'position', operator: 'is', value: 'pos-mer-goto', display: 'pos-mer' }),
    );
    expect(chip.value).toBe('pos-mer');
  });
});

describe('hasFilter', () => {
  it('spots an identical filter so the same chip is not added twice', () => {
    const filters: LedgerFilter[] = [{ id: 'a', column: 'type', operator: 'is', value: 'Buy' }];
    expect(hasFilter(filters, { column: 'type', operator: 'is', value: 'Buy' })).toBe(true);
    expect(hasFilter(filters, { column: 'type', operator: 'not', value: 'Buy' })).toBe(false);
    expect(hasFilter(filters, { column: 'type', operator: 'is', value: 'Sell' })).toBe(false);
  });
});
