import { describe, expect, it } from 'vitest';
import {
  assessFundAiOpinionDataSufficiency,
  clampFundAiOpinionConfidence,
  formatFundAiOpinionDataGaps,
  isFundAiOpinionStale,
  parseFundAiOpinionConfidence,
} from './fundAiOpinionDataSufficiency';

const RICH = {
  sector: 'Robotics',
  country: 'Singapore',
  fmv_amount: 800_000,
  gross_moic: 1.6,
  gross_irr: 0.12,
  invested_capital_amount: 500_000,
  investment_description: 'Series B lead.',
};

describe('assessFundAiOpinionDataSufficiency', () => {
  it('rates a well-marked holding as high confidence', () => {
    const result = assessFundAiOpinionDataSufficiency(RICH, 3);
    expect(result.maxConfidence).toBe('high');
    expect(result.isSparse).toBe(false);
    expect(result.dataGaps).toEqual([]);
  });

  it('caps at low when there is no valuation history', () => {
    const result = assessFundAiOpinionDataSufficiency(RICH, 0);
    expect(result.maxConfidence).toBe('low');
    expect(result.isSparse).toBe(true);
    expect(result.dataGaps).toContain('no valuation history');
  });

  it('caps at medium with a single valuation mark', () => {
    const result = assessFundAiOpinionDataSufficiency(RICH, 1);
    expect(result.maxConfidence).toBe('medium');
    expect(result.dataGaps).toContain('only one valuation mark');
  });

  it('caps at low when many core fields are missing', () => {
    const result = assessFundAiOpinionDataSufficiency(
      {
        sector: null,
        country: null,
        fmv_amount: null,
        gross_moic: null,
        gross_irr: null,
        invested_capital_amount: null,
        investment_description: null,
      },
      3,
    );
    expect(result.maxConfidence).toBe('low');
    expect(result.dataGaps.length).toBeGreaterThanOrEqual(4);
  });
});

describe('clampFundAiOpinionConfidence', () => {
  it('never raises agent confidence above the server ceiling', () => {
    expect(clampFundAiOpinionConfidence('high', 'low')).toBe('low');
    expect(clampFundAiOpinionConfidence('medium', 'low')).toBe('low');
    expect(clampFundAiOpinionConfidence('low', 'medium')).toBe('low');
    expect(clampFundAiOpinionConfidence('high', 'high')).toBe('high');
  });
});

describe('parseFundAiOpinionConfidence', () => {
  it('accepts known levels case-insensitively', () => {
    expect(parseFundAiOpinionConfidence('High')).toBe('high');
    expect(parseFundAiOpinionConfidence('MEDIUM')).toBe('medium');
  });

  it('returns null for blank or unknown values', () => {
    expect(parseFundAiOpinionConfidence('')).toBeNull();
    expect(parseFundAiOpinionConfidence('sure')).toBeNull();
  });
});

describe('formatFundAiOpinionDataGaps / isFundAiOpinionStale', () => {
  it('joins gaps with semicolons', () => {
    expect(formatFundAiOpinionDataGaps(['a', 'b'])).toBe('a; b');
  });

  it('flags stale when a newer valuation mark landed after the opinion', () => {
    expect(isFundAiOpinionStale('2024-06-15T12:00:00Z', '2024-12-31')).toBe(true);
    expect(isFundAiOpinionStale('2025-01-02T00:00:00Z', '2024-12-31')).toBe(false);
    expect(isFundAiOpinionStale(null, '2024-12-31')).toBe(false);
  });
});
