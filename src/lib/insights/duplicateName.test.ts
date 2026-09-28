import { describe, it, expect } from 'vitest';
import { duplicateInsightName } from './duplicateName';

describe('duplicateInsightName', () => {
  const MAX_LEN = 120;

  it.each([
    ['(copy)', []],
    ['(copy 2)', ['Q3 Market Review (copy)']],
    ['(copy 4)', ['Q3 Market Review (copy)', 'Q3 Market Review (copy 2)', 'Q3 Market Review (copy 3)']],
  ])('picks "{base} %s" past the taken names', (suffix, existing) => {
    expect(duplicateInsightName('Q3 Market Review', existing, MAX_LEN)).toBe(`Q3 Market Review ${suffix}`);
  });

  it.each([
    [' (copy)', []],
    [' (copy 2)', [`${'A'.repeat(MAX_LEN - ' (copy)'.length)} (copy)`]],
  ])('truncates a max-length original to fit maxLength with the "%s" suffix', (suffix, existing) => {
    expect(duplicateInsightName('A'.repeat(MAX_LEN), existing, MAX_LEN)).toBe(
      `${'A'.repeat(MAX_LEN - suffix.length)}${suffix}`,
    );
  });

  it('matches existing names after trimming whitespace', () => {
    expect(duplicateInsightName('  Q3 Market Review  ', ['  Q3 Market Review (copy)  '], MAX_LEN)).toBe(
      'Q3 Market Review (copy 2)',
    );
  });

  it('trims trailing whitespace after truncating base', () => {
    // maxLength 13 slices "Hello World" to "Hello " + " (copy)"; trimEnd drops the double space.
    expect(duplicateInsightName('Hello World', [], 13)).toBe('Hello (copy)');
  });
});
