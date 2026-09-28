import { describe, it, expect } from 'vitest';
import {
  insightContentHash,
  normalizeInsightHtml,
  sameInsightContent,
} from './contentHash';

describe('normalizeInsightHtml', () => {
  it('collapses runs of whitespace to one space and trims', () => {
    expect(normalizeInsightHtml('  <p>\n\t a   b </p>\n')).toBe('<p> a b </p>');
  });
});

describe('insightContentHash', () => {
  it('returns a 64-char hex sha256', () => {
    expect(insightContentHash('<p>x</p>')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes whitespace-only variations identically', () => {
    expect(insightContentHash('<html>\n  <body><p>a  b</p></body>\n</html>\n')).toBe(
      insightContentHash('<html> <body><p>a b</p></body> </html>'),
    );
  });

  it('gives different content a different hash', () => {
    expect(insightContentHash('<p>revenue 10</p>')).not.toBe(
      insightContentHash('<p>revenue 11</p>'),
    );
  });
});

describe('sameInsightContent', () => {
  it('is true only for two equal, present hashes', () => {
    expect(sameInsightContent('abc', 'abc')).toBe(true);
    expect(sameInsightContent('abc', 'abd')).toBe(false);
    expect(sameInsightContent(null, 'abc')).toBe(false);
    expect(sameInsightContent('abc', null)).toBe(false);
    // Two missing hashes are not "the same content".
    expect(sameInsightContent(null, null)).toBe(false);
    expect(sameInsightContent(undefined, undefined)).toBe(false);
  });
});
