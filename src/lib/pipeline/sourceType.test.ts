import { describe, it, expect } from 'vitest';
import {
  matchesSourceFilter,
  normalizeSourceType,
  sourceTypeLabel,
} from './sourceType';

describe('normalizeSourceType', () => {
  it('resolves inbound and outbound regardless of case and whitespace', () => {
    expect(normalizeSourceType('inbound')).toBe('inbound');
    expect(normalizeSourceType(' Outbound ')).toBe('outbound');
    expect(normalizeSourceType('INBOUND')).toBe('inbound');
  });

  it('returns null for missing or unrecognised values', () => {
    expect(normalizeSourceType(null)).toBeNull();
    expect(normalizeSourceType(undefined)).toBeNull();
    expect(normalizeSourceType('')).toBeNull();
    expect(normalizeSourceType('referral')).toBeNull();
  });
});

describe('sourceTypeLabel', () => {
  it('labels inbound and outbound deals', () => {
    expect(sourceTypeLabel('inbound')).toBe('Inbound');
    expect(sourceTypeLabel('outbound')).toBe('Outbound');
  });

  it('returns null when the deal has no recognised source', () => {
    expect(sourceTypeLabel(null)).toBeNull();
    expect(sourceTypeLabel('referral')).toBeNull();
  });
});

describe('matchesSourceFilter', () => {
  it('keeps every deal, sourceless ones included, under all', () => {
    expect(matchesSourceFilter({ source: 'inbound' }, 'all')).toBe(true);
    expect(matchesSourceFilter({ source: 'outbound' }, 'all')).toBe(true);
    expect(matchesSourceFilter({ source: null }, 'all')).toBe(true);
  });

  it('keeps only the selected source type otherwise', () => {
    expect(matchesSourceFilter({ source: 'inbound' }, 'inbound')).toBe(true);
    expect(matchesSourceFilter({ source: 'Inbound' }, 'inbound')).toBe(true);
    expect(matchesSourceFilter({ source: 'outbound' }, 'inbound')).toBe(false);
    expect(matchesSourceFilter({ source: null }, 'outbound')).toBe(false);
  });
});
