import { describe, expect, it } from 'vitest';
import { plainTextLength, reviewerColumnWeights } from './reviewerLayout';

describe('plainTextLength', () => {
  it('returns 0 for empty, null and undefined bodies', () => {
    expect(plainTextLength(null)).toBe(0);
    expect(plainTextLength(undefined)).toBe(0);
    expect(plainTextLength('')).toBe(0);
  });

  it('ignores markup so tag-heavy ballots are not credited extra width', () => {
    const plain = plainTextLength('<p>Solid unit economics.</p>');
    const bulleted = plainTextLength(
      '<ul><li><strong>Solid</strong></li><li><em>unit economics.</em></li></ul>',
    );
    expect(plain).toBe('Solid unit economics.'.length);
    expect(bulleted).toBeLessThanOrEqual(plain);
  });

  it('counts an entity as the single character it renders as', () => {
    expect(plainTextLength('<p>A&nbsp;B</p>')).toBe(3);
    expect(plainTextLength('<p>A&amp;B</p>')).toBe(3);
  });

  it('collapses whitespace introduced by block tags', () => {
    expect(plainTextLength('<p>one</p>\n\n<p>two</p>')).toBe('one two'.length);
  });
});

describe('reviewerColumnWeights', () => {
  it('returns [] for no reviewers', () => {
    expect(reviewerColumnWeights([])).toEqual([]);
  });

  it('gives equal width to rationales that are all short', () => {
    expect(reviewerColumnWeights([0, 12, 90, 140])).toEqual([1, 1, 1, 1]);
  });

  it('widens the longer rationale relative to the shorter one', () => {
    const [short, long] = reviewerColumnWeights([140, 900]);
    expect(short).toBe(1);
    expect(long).toBeGreaterThan(1);
  });

  it('grows sub-linearly so a 10x longer ballot is nowhere near 10x as wide', () => {
    const [, long] = reviewerColumnWeights([200, 2000]);
    expect(long).toBeLessThan(4);
  });

  it('caps the widest column at 2.2x the narrowest', () => {
    const weights = reviewerColumnWeights([140, 500, 50_000]);
    expect(Math.max(...weights)).toBe(2.2);
  });

  it('keeps every column at or above the narrowest reviewer', () => {
    for (const weight of reviewerColumnWeights([300, 140, 12, 4000, 700])) {
      expect(weight).toBeGreaterThanOrEqual(1);
    }
  });

  it('is order-independent — the same lengths shuffled give the same weights', () => {
    const [a, b, c] = reviewerColumnWeights([140, 1400, 600]);
    expect(reviewerColumnWeights([600, 140, 1400])).toEqual([c, a, b]);
  });

  it('treats a single reviewer as a full-weight column', () => {
    expect(reviewerColumnWeights([9000])).toEqual([1]);
  });

  it('tolerates NaN lengths by treating them as empty', () => {
    expect(reviewerColumnWeights([Number.NaN, 140])).toEqual([1, 1]);
  });
});
