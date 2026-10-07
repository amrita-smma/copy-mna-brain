import { describe, expect, it } from 'vitest';

import { dealType } from '@/lib/db/schema';
import {
  DEAL_TYPES,
  DEAL_TYPE_LABEL,
  DEAL_TYPE_OPTIONS,
  DEFAULT_DEAL_TYPE,
  formatDealType,
  isDealType,
  normalizeDealType,
} from './dealTypes';

describe('DEAL_TYPES', () => {
  it('matches the deal_type Postgres enum exactly, in the same order', () => {
    // The guard this module exists for: widening the enum in schema.ts without
    // widening the vocabulary here (or vice versa) silently desyncs the DB from
    // the UI labels and the agent tool argument validation.
    expect([...dealType.enumValues]).toEqual([...DEAL_TYPES]);
  });

  it('keeps the two original values first so the column default stays valid', () => {
    expect(DEAL_TYPES[0]).toBe('majority');
    expect(DEAL_TYPES[1]).toBe('minority');
    expect(DEFAULT_DEAL_TYPE).toBe('majority');
  });

  it('has no duplicate values', () => {
    expect(new Set(DEAL_TYPES).size).toBe(DEAL_TYPES.length);
  });

  it('labels every value with a non-empty string', () => {
    for (const value of DEAL_TYPES) {
      expect(DEAL_TYPE_LABEL[value]).toBeTruthy();
    }
  });

  it('covers the investment-banking and public-market additions', () => {
    expect(DEAL_TYPES).toContain('public_market');
    expect(DEAL_TYPES).toContain('bond_issuance');
    expect(DEAL_TYPES).toContain('equity_crowdfunding');
    expect(DEAL_TYPE_LABEL.public_market).toBe('Public Market Investing');
    expect(DEAL_TYPE_LABEL.bond_issuance).toBe('Bond Issuance');
    expect(DEAL_TYPE_LABEL.equity_crowdfunding).toBe('Equity Crowdfunding');
  });
});

describe('DEAL_TYPE_OPTIONS', () => {
  it('pairs every value with its label, in display order', () => {
    expect(DEAL_TYPE_OPTIONS.map((o) => o.value)).toEqual([...DEAL_TYPES]);
    expect(DEAL_TYPE_OPTIONS.map((o) => o.label)).toEqual(
      DEAL_TYPES.map((v) => DEAL_TYPE_LABEL[v]),
    );
  });
});

describe('isDealType', () => {
  it('accepts every enum value', () => {
    for (const value of DEAL_TYPES) expect(isDealType(value)).toBe(true);
  });

  it('rejects unknown strings and non-strings', () => {
    expect(isDealType('Majority')).toBe(false);
    expect(isDealType('control')).toBe(false);
    expect(isDealType('')).toBe(false);
    expect(isDealType(null)).toBe(false);
    expect(isDealType(undefined)).toBe(false);
    expect(isDealType(7)).toBe(false);
  });
});

describe('normalizeDealType', () => {
  it('passes enum values through unchanged', () => {
    for (const value of DEAL_TYPES) expect(normalizeDealType(value)).toBe(value);
  });

  it('accepts the label spellings a human or an LLM writes', () => {
    expect(normalizeDealType('Majority')).toBe('majority');
    expect(normalizeDealType('  Minority  ')).toBe('minority');
    expect(normalizeDealType('Public Market Investing')).toBe('public_market');
    expect(normalizeDealType('public markets')).toBe('public_market');
    expect(normalizeDealType('Bond Issuance')).toBe('bond_issuance');
    expect(normalizeDealType('bonds')).toBe('bond_issuance');
    expect(normalizeDealType('IPO')).toBe('ipo');
    expect(normalizeDealType('Initial Public Offering')).toBe('ipo');
    expect(normalizeDealType('Follow-on Offering')).toBe('follow_on_offering');
    expect(normalizeDealType('follow on')).toBe('follow_on_offering');
    expect(normalizeDealType('M&A Advisory')).toBe('ma_advisory');
    expect(normalizeDealType('M and A Advisory')).toBe('ma_advisory');
    expect(normalizeDealType('Private Placement')).toBe('private_placement');
    expect(normalizeDealType('Equity Crowdfunding')).toBe('equity_crowdfunding');
    expect(normalizeDealType('crowdfunding')).toBe('equity_crowdfunding');
    expect(normalizeDealType('Joint Venture')).toBe('joint_venture');
    expect(normalizeDealType('JV')).toBe('joint_venture');
  });

  it('refuses bare words that name a family rather than a deal type', () => {
    // "advisory" does not distinguish an M&A mandate from a restructuring one,
    // and "debt" does not distinguish a bond issuance from a loan — guessing
    // mislabels the deal silently, so the tool must refuse and ask.
    expect(normalizeDealType('advisory')).toBeUndefined();
    expect(normalizeDealType('debt')).toBeUndefined();
  });

  it('returns undefined for anything it cannot place', () => {
    expect(normalizeDealType('control buyout')).toBeUndefined();
    expect(normalizeDealType('')).toBeUndefined();
    expect(normalizeDealType('   ')).toBeUndefined();
    expect(normalizeDealType(null)).toBeUndefined();
    expect(normalizeDealType(undefined)).toBeUndefined();
  });
});

describe('formatDealType', () => {
  it('renders the label for a known value', () => {
    expect(formatDealType('majority')).toBe('Majority');
    expect(formatDealType('public_market')).toBe('Public Market Investing');
    expect(formatDealType('ma_advisory')).toBe('M&A Advisory');
    expect(formatDealType('ipo')).toBe('IPO');
  });

  it('returns null for an empty value so callers can fall back to a dash', () => {
    expect(formatDealType(null)).toBeNull();
    expect(formatDealType(undefined)).toBeNull();
    expect(formatDealType('')).toBeNull();
  });

  it('title-cases an unknown value rather than dropping it', () => {
    // A row written by a newer build, or a DB enum value not yet labelled here.
    expect(formatDealType('spac_merger')).toBe('Spac Merger');
    expect(formatDealType('carve out')).toBe('Carve Out');
  });
});
