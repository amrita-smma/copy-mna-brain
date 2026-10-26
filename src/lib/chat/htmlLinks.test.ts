import { describe, it, expect } from 'vitest';

import { htmlAnchorsToMarkdown } from './htmlLinks';

describe('htmlAnchorsToMarkdown', () => {
  it('returns the same string when there is no anchor', () => {
    const text = 'See [Acme](https://acme.com) and https://example.com';
    expect(htmlAnchorsToMarkdown(text)).toBe(text);
  });

  it('rewrites a double-quoted anchor as a markdown link', () => {
    expect(htmlAnchorsToMarkdown('Visit <a href="https://acme.com">Acme</a> today')).toBe(
      'Visit [Acme](<https://acme.com>) today',
    );
  });

  it('rewrites a single-quoted and an unquoted href', () => {
    expect(htmlAnchorsToMarkdown("<a href='https://a.com'>A</a>")).toBe('[A](<https://a.com>)');
    expect(htmlAnchorsToMarkdown('<a href=https://b.com>B</a>')).toBe('[B](<https://b.com>)');
  });

  it('ignores other attributes and tag casing', () => {
    expect(
      htmlAnchorsToMarkdown('<A target="_blank" HREF="https://acme.com" rel="noopener">Acme</A >'),
    ).toBe('[Acme](<https://acme.com>)');
  });

  it('rewrites every anchor in the text', () => {
    expect(
      htmlAnchorsToMarkdown('<a href="https://a.com">A</a>, <a href="https://b.com">B</a>'),
    ).toBe('[A](<https://a.com>), [B](<https://b.com>)');
  });

  it('keeps a multi-line anchor body on one link', () => {
    expect(htmlAnchorsToMarkdown('<a href="https://a.com">\n  Acme Corp\n</a>')).toBe(
      '[Acme Corp](<https://a.com>)',
    );
  });

  it('uses the href as the label when the anchor is empty', () => {
    expect(htmlAnchorsToMarkdown('<a href="https://a.com"></a>')).toBe(
      '[https://a.com](<https://a.com>)',
    );
  });

  it('keeps relative, mailto, tel and fragment destinations', () => {
    expect(htmlAnchorsToMarkdown('<a href="/companies/42">Acme</a>')).toBe('[Acme](</companies/42>)');
    expect(htmlAnchorsToMarkdown('<a href="mailto:x@y.com">mail</a>')).toBe('[mail](<mailto:x@y.com>)');
    expect(htmlAnchorsToMarkdown('<a href="tel:+123">call</a>')).toBe('[call](<tel:+123>)');
    expect(htmlAnchorsToMarkdown('<a href="#top">top</a>')).toBe('[top](<#top>)');
  });

  it('decodes entities in the href and keeps parentheses and spaces in it', () => {
    expect(
      htmlAnchorsToMarkdown('<a href="https://a.com/?x=1&amp;y=2">A</a>'),
    ).toBe('[A](<https://a.com/?x=1&y=2>)');
    expect(
      htmlAnchorsToMarkdown('<a href="https://en.wikipedia.org/wiki/Acme_(company)">A</a>'),
    ).toBe('[A](<https://en.wikipedia.org/wiki/Acme_(company)>)');
  });

  it('escapes square brackets in the label', () => {
    expect(htmlAnchorsToMarkdown('<a href="https://a.com">[1] Acme</a>')).toBe(
      '[\\[1\\] Acme](<https://a.com>)',
    );
  });

  it('reduces an unsafe or missing destination to its text', () => {
    expect(htmlAnchorsToMarkdown('<a href="javascript:alert(1)">click</a>')).toBe('click');
    expect(htmlAnchorsToMarkdown('<a href="data:text/html,x">click</a>')).toBe('click');
    expect(htmlAnchorsToMarkdown('<a href="//evil.com">click</a>')).toBe('click');
    expect(htmlAnchorsToMarkdown('<a name="x">click</a>')).toBe('click');
    expect(htmlAnchorsToMarkdown('<a href="https://good.com\njavascript:alert(1)">click</a>')).toBe(
      'click',
    );
  });

  it('leaves anchors inside code untouched', () => {
    const fenced = 'Use:\n```html\n<a href="https://a.com">A</a>\n```\nand <a href="https://b.com">B</a>';
    expect(htmlAnchorsToMarkdown(fenced)).toBe(
      'Use:\n```html\n<a href="https://a.com">A</a>\n```\nand [B](<https://b.com>)',
    );
    expect(htmlAnchorsToMarkdown('`<a href="https://a.com">A</a>`')).toBe(
      '`<a href="https://a.com">A</a>`',
    );
  });

  it('leaves an unclosed anchor alone while it is still streaming', () => {
    const partial = 'See <a href="https://a.com">Ac';
    expect(htmlAnchorsToMarkdown(partial)).toBe(partial);
  });
});
