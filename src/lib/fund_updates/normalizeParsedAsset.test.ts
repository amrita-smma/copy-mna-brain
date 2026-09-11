import { describe, expect, it } from 'vitest';
import type { ParsedAsset, ParsedValuation } from './parsers/startech_quarterly';
import {
  earliestFundUpdatePositionDate,
  earliestIsoDate,
  isPersistableFundUpdateValuation,
  normalizeParsedAsset,
  quarterPeriodLabel,
} from './normalizeParsedAsset';

function sampleAsset(overrides: Partial<ParsedAsset> = {}): ParsedAsset {
  return {
    code: 'ACME',
    name: 'Acme',
    legalName: null,
    country: null,
    investmentTypeLabel: 'Direct Investments',
    assetType: 'direct_investment',
    fund: 'Fund I',
    entity: null,
    fundingSource: 'DCA',
    fundingSourceRaw: null,
    entryDate: '2026-01-15',
    stakePct: null,
    commitmentAmount: null,
    dealType: null,
    mgmtFeeRatePct: null,
    sector: null,
    subSector: null,
    instrument: null,
    sharesOutstanding: null,
    sourceRef: null,
    vintageYear: null,
    valuations: [],
    currentPricePerShare: null,
    txns: [],
    ...overrides,
  };
}

describe('quarterPeriodLabel', () => {
  it('maps month to calendar quarter', () => {
    expect(quarterPeriodLabel('2025-12-31')).toBe('Q4 2025');
    expect(quarterPeriodLabel('2026-01-15')).toBe('Q1 2026');
  });
});

describe('earliestIsoDate / earliestFundUpdatePositionDate', () => {
  it('returns the earliest valid ISO date and ignores junk', () => {
    expect(earliestIsoDate('2026-01-15', '2025-12-31', 'nope', null)).toBe('2025-12-31');
  });

  it('uses entry, txn, and valuation dates the same way for every parser', () => {
    expect(
      earliestFundUpdatePositionDate({
        entryDate: '2026-01-15',
        txnDates: ['2026-01-15'],
        valuationDates: ['2025-12-31'],
      }),
    ).toBe('2025-12-31');
  });
});

describe('normalizeParsedAsset', () => {
  it('fills the same optional fields, drops invalid dates, and uses Q-period labels', () => {
    const normalized = normalizeParsedAsset(
      sampleAsset({
        txns: [
          {
            date: '2026-01-15',
            type: 'contribution',
            subTypeLabel: null,
            pricePerShare: null,
            shareCount: null,
            valueAmount: 100,
            fxRate: null,
            notes: null,
          },
          {
            date: 'not-a-date',
            type: 'other',
            subTypeLabel: null,
            pricePerShare: null,
            shareCount: null,
            valueAmount: 1,
            fxRate: null,
            notes: null,
          } as never,
        ],
        valuations: [
          {
            asOfDate: '2025-12-31',
            periodLabel: '2025-12',
            marketValue: 90,
            pricePerShare: 1.5,
            sharesOutstanding: null,
            shareholdingPct: null,
            investedCapitalCum: null,
            grossMoic: null,
            grossXirr: null,
            valuationMethod: 'at_cost',
            notes: null,
          },
        ],
      }),
    );

    expect(normalized.fundingSourceRaw).toBe('DCA');
    expect(normalized.txns).toHaveLength(1);
    expect(normalized.valuations[0].periodLabel).toBe('Q4 2025');
    expect(normalized.currentPricePerShare).toBe(1.5);
  });

  it('applies sane defaults for non-startech assets without group or holder fields', () => {
    const normalized = normalizeParsedAsset(
      sampleAsset({
        fund: 'Growth Fund',
        entity: null,
      }),
    );

    expect(normalized.holderKind).toBe('fund');
    expect(normalized.group).toBe('Growth Fund');
    expect(normalized.holderName).toBeNull();
    expect(normalized.entityIsComposite).toBe(false);
    expect(normalized.entityIsUnattributed).toBe(false);
  });

  it('defaults holderName to asset.entity when entity is present on non-startech assets', () => {
    const normalized = normalizeParsedAsset(
      sampleAsset({
        fund: 'Growth Fund',
        entity: 'Holding Corp',
      }),
    );

    expect(normalized.holderKind).toBe('fund');
    expect(normalized.group).toBe('Growth Fund');
    expect(normalized.holderName).toBe('Holding Corp');
  });

  it('preserves explicit group and holder fields when supplied', () => {
    const normalized = normalizeParsedAsset(
      sampleAsset({
        fund: 'Startech Growth Fund 1',
        group: 'Startech Growth Fund 1',
        holderKind: 'investor',
        holderName: 'Unattributed (STARTECH)',
        entity: null,
        entityIsComposite: false,
        entityIsUnattributed: true,
      }),
    );

    expect(normalized.holderKind).toBe('investor');
    expect(normalized.group).toBe('Startech Growth Fund 1');
    expect(normalized.holderName).toBe('Unattributed (STARTECH)');
    expect(normalized.entityIsComposite).toBe(false);
    expect(normalized.entityIsUnattributed).toBe(true);
  });
});

describe('isPersistableFundUpdateValuation', () => {
  const base = { asOfDate: '2025-12-31', marketValue: 100 } as unknown as ParsedValuation;

  it('accepts a valuation that carries a market value, including zero', () => {
    expect(isPersistableFundUpdateValuation(base)).toBe(true);
    expect(isPersistableFundUpdateValuation({ ...base, marketValue: 0 })).toBe(true);
  });

  it('rejects an auxiliary-only row with no market value', () => {
    expect(isPersistableFundUpdateValuation({ ...base, marketValue: null })).toBe(false);
    expect(isPersistableFundUpdateValuation({ ...base, marketValue: undefined })).toBe(false);
  });
});
