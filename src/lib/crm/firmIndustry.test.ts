import { describe, it, expect } from 'vitest';
import { FIRM_INDUSTRIES, toFirmIndustry } from './firmIndustry';

describe('toFirmIndustry', () => {
  it('returns the canonical label whatever the case and spacing', () => {
    expect(toFirmIndustry('  private credit ')).toBe('Private Credit');
    expect(toFirmIndustry('AUDIT & ACCOUNTING')).toBe('Audit & Accounting');
  });

  it('returns null for empty input and anything outside the set', () => {
    expect(toFirmIndustry(null)).toBeNull();
    expect(toFirmIndustry('')).toBeNull();
    expect(toFirmIndustry('PE firm')).toBeNull();
  });

  it('has no duplicate labels ignoring case', () => {
    expect(new Set(FIRM_INDUSTRIES.map((l) => l.toLowerCase())).size).toBe(FIRM_INDUSTRIES.length);
  });
});
