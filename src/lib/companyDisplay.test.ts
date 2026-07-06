import { describe, it, expect } from 'vitest';
import { nameInitials, companyInitials } from './companyDisplay';

describe('nameInitials', () => {
  it('takes the first English letter of the first two words', () => {
    expect(nameInitials('Acme Holdings')).toBe('AH');
  });

  it('uppercases the resolved letters', () => {
    expect(nameInitials('acme holdings')).toBe('AH');
  });

  it('skips leading non-English characters within a word', () => {
    // "3M" → M (digit skipped); "&Co" → C (symbol skipped).
    expect(nameInitials('3M &Corp')).toBe('MC');
  });

  it('ignores words with no English letter and uses the next qualifying words', () => {
    // 北京 has no Latin letter, so Semi + Corp supply the two initials.
    expect(nameInitials('北京 Semi Corp')).toBe('SC');
  });

  it('returns a single letter when only one word has an English letter', () => {
    expect(nameInitials('株式会社 Kabu')).toBe('K');
  });

  it('returns the fallback when no word has an English letter', () => {
    expect(nameInitials('株式会社 北京', 'X')).toBe('X');
  });

  it('defaults the fallback to "U"', () => {
    expect(nameInitials('株式会社')).toBe('U');
  });

  it('handles empty / nullish input via the fallback', () => {
    expect(nameInitials('', 'X')).toBe('X');
    expect(nameInitials(null, 'X')).toBe('X');
    expect(nameInitials(undefined, 'X')).toBe('X');
  });

  it('collapses irregular whitespace before picking words', () => {
    expect(nameInitials('  Alpha   Beta  ')).toBe('AB');
  });
});

describe('companyInitials', () => {
  it('derives English-only initials from the display name', () => {
    expect(companyInitials({ target: 'Alpha Beta' })).toBe('AB');
  });

  it('prefers target over name over project_name', () => {
    expect(
      companyInitials({ target: 'Green Energy', name: 'Ignored', project_name: 'Nope' }),
    ).toBe('GE');
  });

  it('falls back to the provided fallback when the name has no English letters', () => {
    expect(companyInitials({ target: '株式会社' }, 'Z')).toBe('Z');
  });
});
