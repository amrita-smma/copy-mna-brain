import { describe, it, expect } from 'vitest';
import {
  MAX_INSIGHT_NESTING_DEPTH,
  TOO_DEEPLY_NESTED_MESSAGE,
  isTooDeeplyNested,
  parseInsightHtml,
  rejectTooDeeplyNested,
} from './parseHtml';

const nested = (depth: number) => '<div>'.repeat(depth) + 'x' + '</div>'.repeat(depth);

describe('parseInsightHtml', () => {
  it('parses unclosed nesting in linear time', () => {
    // 32 KB of unclosed <div>s took ~19 s with the library's default repair pass.
    const started = performance.now();
    parseInsightHtml('<div>'.repeat(6_553));
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('parses many unclosed elements holding many children in linear time', () => {
    // 50 unclosed elements × 2,000 children took ~64 s by default.
    const started = performance.now();
    parseInsightHtml(('<div>' + '<i>x</i>'.repeat(2_000)).repeat(50));
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it('keeps an ordinary document intact', () => {
    const root = parseInsightHtml(
      '<html><head><title>T</title></head><body><section data-section="a"><p>Hi <b>there</b></p></section></body></html>',
    );
    expect(root.querySelector('title')?.text).toBe('T');
    expect(root.querySelector('[data-section="a"] b')?.text).toBe('there');
  });

  it('lets a closing tag close the elements still open inside it, as a browser does', () => {
    const root = parseInsightHtml('<div id="a"><span>x</div><p id="b">y</p>');
    expect(root.querySelector('#b')?.parentNode).toBe(root);
  });

  it('passes extra parser options through', () => {
    const root = parseInsightHtml('<p>a<!-- note --></p>', { comment: true });
    expect(root.toString()).toContain('<!-- note -->');
  });
});

describe('isTooDeeplyNested', () => {
  it('allows nesting up to the limit and refuses one level past it', () => {
    expect(isTooDeeplyNested(parseInsightHtml(nested(MAX_INSIGHT_NESTING_DEPTH)))).toBe(false);
    expect(isTooDeeplyNested(parseInsightHtml(nested(MAX_INSIGHT_NESTING_DEPTH + 1)))).toBe(true);
  });

  it('measures a tree far too deep for a recursive walk without overflowing', () => {
    expect(isTooDeeplyNested(parseInsightHtml('<div>'.repeat(200_000)))).toBe(true);
  });

  it('does not count siblings or repeated mismatched closers as depth', () => {
    expect(isTooDeeplyNested(parseInsightHtml('<p>x</p>'.repeat(5_000)))).toBe(false);
    expect(isTooDeeplyNested(parseInsightHtml('<div><span></div>'.repeat(2_000)))).toBe(false);
    expect(isTooDeeplyNested(parseInsightHtml('<ul>' + '<li>x'.repeat(5_000) + '</ul>'))).toBe(false);
  });
});

describe('rejectTooDeeplyNested', () => {
  it('returns the refusal for a too-deep document and null otherwise', () => {
    expect(rejectTooDeeplyNested('<span>x'.repeat(1_000))).toBe(TOO_DEEPLY_NESTED_MESSAGE);
    expect(rejectTooDeeplyNested(nested(20))).toBeNull();
  });
});
