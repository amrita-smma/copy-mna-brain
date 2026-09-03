import { describe, it, expect } from 'vitest';
import { htmlToPlainText, sanitizeBallotHtml } from './html';

describe('sanitizeBallotHtml', () => {
  it('keeps the formatting tags the editor toolbar produces', () => {
    const html =
      '<p><strong>Bold</strong> <em>italic</em> <u>underline</u></p><ul><li>one</li></ul><ol><li>two</li></ol>';

    expect(sanitizeBallotHtml(html)).toBe(html);
  });

  it('drops script tags entirely, content included', () => {
    const out = sanitizeBallotHtml('<p>ok</p><script>alert(1)</script>');

    expect(out).toBe('<p>ok</p>');
  });

  it('unwraps unknown tags but keeps their text', () => {
    expect(sanitizeBallotHtml('<article><p>kept</p></article>')).toBe('<p>kept</p>');
  });

  it('strips event-handler attributes', () => {
    expect(sanitizeBallotHtml('<p onclick="steal()">hi</p>')).toBe('<p>hi</p>');
  });

  it('keeps only the allowed inline style props', () => {
    const out = sanitizeBallotHtml(
      '<span style="font-size: 18px; position: fixed; background: url(x)">big</span>',
    );

    expect(out).toBe('<span style="font-size: 18px">big</span>');
  });

  it('keeps margin-left so Tab indentation survives a round trip', () => {
    expect(sanitizeBallotHtml('<p style="margin-left: 48px">indented</p>')).toBe(
      '<p style="margin-left: 48px">indented</p>',
    );
  });

  it('rejects a font-size value that is not a CSS length', () => {
    expect(sanitizeBallotHtml('<span style="font-size: expression(1)">x</span>')).toBe(
      '<span>x</span>',
    );
  });

  it('keeps http links and hardens them with rel/target', () => {
    const out = sanitizeBallotHtml('<p><a href="https://example.com">link</a></p>');

    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });

  it('drops a javascript: href while keeping the link text', () => {
    const out = sanitizeBallotHtml('<p><a href="javascript:alert(1)">click</a></p>');

    expect(out).not.toContain('javascript');
    expect(out).toContain('click');
  });

  it('returns null for an empty editor body', () => {
    expect(sanitizeBallotHtml('<p></p>')).toBeNull();
    expect(sanitizeBallotHtml('')).toBeNull();
    expect(sanitizeBallotHtml(null)).toBeNull();
  });

  it('keeps a body that is only a line break', () => {
    expect(sanitizeBallotHtml('<p><br></p>')).toBe('<p><br></p>');
  });
});

describe('htmlToPlainText', () => {
  it('puts each paragraph on its own line', () => {
    expect(htmlToPlainText('<p>one</p><p>two</p>')).toBe('one\ntwo');
  });

  it('folds inline marks into the surrounding line', () => {
    expect(htmlToPlainText('<p>Support <strong>signing</strong> the NDA.</p>')).toBe(
      'Support signing the NDA.',
    );
  });

  it('bullets list items', () => {
    expect(htmlToPlainText('<ul><li>a</li><li>b</li></ul>')).toBe('- a\n- b');
  });

  it('keeps nested list items on separate lines', () => {
    expect(htmlToPlainText('<ul><li>a<ul><li>b</li></ul></li></ul>')).toBe('a\n- b');
  });

  it('returns an empty string for empty input', () => {
    expect(htmlToPlainText(null)).toBe('');
    expect(htmlToPlainText('<p></p>')).toBe('');
  });

  it('ignores script content', () => {
    expect(htmlToPlainText('<p>ok</p><script>bad()</script>')).toBe('ok');
  });
});
