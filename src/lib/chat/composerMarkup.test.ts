import { describe, it, expect } from 'vitest';

import { stripComposerMarkup } from './composerMarkup';

describe('stripComposerMarkup', () => {
  it('leaves a plain message untouched', () => {
    expect(stripComposerMarkup('Summarize this deal')).toBe('Summarize this deal');
  });

  it('removes the attachment lines the composer appends', () => {
    expect(stripComposerMarkup('Review this\n\n📎 Attached: Teaser.pdf')).toBe('Review this');
  });

  it('removes every attachment line when several files are attached', () => {
    const text = 'Compare them\n📎 Attached: A.pdf\n📎 Attached: B.xlsx';
    expect(stripComposerMarkup(text)).toBe('Compare them');
  });

  it('removes the hidden attach_id marker', () => {
    const text = 'Look\n📎 Attached: A.pdf\n<!-- attach_id: 7f3a -->';
    expect(stripComposerMarkup(text)).toBe('Look');
  });

  it('returns an empty string for an attachment-only turn', () => {
    expect(stripComposerMarkup('📎 Attached: A.pdf\n<!-- attach_id: 7f3a -->')).toBe('');
  });

  it('trims surrounding whitespace', () => {
    expect(stripComposerMarkup('  hello  ')).toBe('hello');
  });

  it('keeps an inner mention of an attachment name that is not the composer line', () => {
    expect(stripComposerMarkup('What does Teaser.pdf say?')).toBe('What does Teaser.pdf say?');
  });
});
