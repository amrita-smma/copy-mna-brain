import { describe, it, expect } from 'vitest';
import { rejectInvalidInsightDocument } from './documentGuard';
import { TOO_DEEPLY_NESTED_MESSAGE } from './parseHtml';
import { rejectPlaceholderDocument } from './documentGuard';

describe('rejectPlaceholderDocument', () => {
  it('rejects the bare word a model submits when it means "read it from my sandbox"', () => {
    const problem = rejectPlaceholderDocument('PLACEHOLDER');
    expect(problem).toContain('BY VALUE');
  });

  it('rejects prose that references a file instead of carrying the document', () => {
    expect(rejectPlaceholderDocument('See /tmp/benchmarking.html')).not.toBeNull();
    expect(rejectPlaceholderDocument('TODO')).not.toBeNull();
  });

  it.each([
    ['a full document', '<!DOCTYPE html><html><head><title>x</title></head><body><p>hi</p></body></html>'],
    ['a bare fragment, which buildInsightSrcDoc renders happily', '<section data-section="risk">x</section>'],
    ['a document that opens with a comment', '<!-- built by the copilot --><div>x</div>'],
    ['a document that opens with a lowercase doctype', '<!doctype html><body>x</body>'],
  ])('accepts %s', (_, html) => {
    expect(rejectPlaceholderDocument(html)).toBeNull();
  });

  it('does not mistake a stray angle bracket in prose for a tag', () => {
    expect(rejectPlaceholderDocument('revenue > 10m, margin < 5%')).not.toBeNull();
  });
});

describe('rejectInvalidInsightDocument', () => {
  it('refuses a document nested too deeply for the outline to walk', () => {
    expect(rejectInvalidInsightDocument('<div>'.repeat(1_000))).toBe(TOO_DEEPLY_NESTED_MESSAGE);
  });

  it('passes an ordinary document', () => {
    expect(rejectInvalidInsightDocument('<section data-section="a"><p>x</p></section>')).toBeNull();
  });
});
