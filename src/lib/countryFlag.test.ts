import { describe, it, expect } from 'vitest';
import { alpha2ToFlag, countryCode, countryFlag } from './countryFlag';

describe('alpha2ToFlag', () => {
  it('maps a two-letter code to its regional-indicator flag', () => {
    expect(alpha2ToFlag('JP')).toBe('🇯🇵');
    expect(alpha2ToFlag('id')).toBe('🇮🇩');
  });

  it('falls back to a globe for anything that is not a two-letter code', () => {
    expect(alpha2ToFlag('')).toBe('🌐');
    expect(alpha2ToFlag('USA')).toBe('🌐');
    expect(alpha2ToFlag('1A')).toBe('🌐');
  });
});

describe('countryCode', () => {
  it('resolves a country name or alias to its alpha-2 code', () => {
    expect(countryCode('Indonesia')).toBe('ID');
    expect(countryCode('USA')).toBe('US');
    expect(countryCode('Korea')).toBe('KR');
  });

  it('returns null for a region or a list of countries', () => {
    expect(countryCode('Asia Pacific')).toBeNull();
    expect(countryCode('Malaysia, Singapore')).toBeNull();
  });
});

describe('countryFlag', () => {
  it('resolves a country name, tolerating inconsistent spellings', () => {
    expect(countryFlag('Indonesia')).toBe('🇮🇩');
    expect(countryFlag('United States')).toBe('🇺🇸');
    expect(countryFlag('USA')).toBe('🇺🇸');
  });

  it('resolves bare "Korea" to South Korea, which the library cannot disambiguate', () => {
    expect(countryFlag('Korea')).toBe('🇰🇷');
    expect(countryFlag('  korea  ')).toBe('🇰🇷');
  });

  it('falls back to a globe for a region or an unrecognised value', () => {
    expect(countryFlag('Asia Pacific')).toBe('🌐');
    expect(countryFlag('')).toBe('🌐');
  });
});
