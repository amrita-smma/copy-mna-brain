import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities, isoDay } from './displayText';

describe('decodeHtmlEntities', () => {
  it.each([
    ['Smith &amp;amp; Co', 'Smith & Co'],
    ['O&#39;Brien', "O'Brien"],
    ['PT Maju &amp; Jaya', 'PT Maju & Jaya'],
    ['株式会社テスト', '株式会社テスト'],
    ['A <B> "C"', 'A <B> "C"'],
  ])('decodes %j to %j', (input, expected) => {
    expect(decodeHtmlEntities(input)).toBe(expected);
  });

  it('decodes every named entity it supports', () => {
    expect(decodeHtmlEntities('&lt;a&gt; &quot;b&quot; &apos;c&apos; d&nbsp;e')).toBe(
      `<a> "b" 'c' d e`,
    );
  });

  it('decodes decimal and hex numeric entities, including astral ones', () => {
    expect(decodeHtmlEntities('&#38; &#x26; &#X27; &#x1F600;')).toBe("& & ' 😀");
  });

  it('decodes escaped entities up to three layers deep and no further', () => {
    expect(decodeHtmlEntities('&amp;lt;b&amp;gt;')).toBe('<b>');
    expect(decodeHtmlEntities('&amp;amp;amp;')).toBe('&');
    expect(decodeHtmlEntities('&amp;amp;amp;amp;')).toBe('&amp;');
  });

  it('leaves plain ampersands, unknown entities and stray semicolons untouched', () => {
    expect(decodeHtmlEntities('AT&T')).toBe('AT&T');
    expect(decodeHtmlEntities('Johnson & Johnson')).toBe('Johnson & Johnson');
    expect(decodeHtmlEntities('&copy; &foo; & ;')).toBe('&copy; &foo; & ;');
  });

  it('leaves out-of-range, NUL and surrogate code points as written instead of throwing', () => {
    expect(decodeHtmlEntities('a&#x110000;b')).toBe('a&#x110000;b');
    expect(decodeHtmlEntities('a&#0;b')).toBe('a&#0;b');
    expect(decodeHtmlEntities('a&#xD800;b')).toBe('a&#xD800;b');
    expect(decodeHtmlEntities('a&#9999999;b')).toBe('a&#9999999;b');
  });

  it('passes null, undefined and the empty string through', () => {
    expect(decodeHtmlEntities(null)).toBeNull();
    expect(decodeHtmlEntities(undefined)).toBeUndefined();
    expect(decodeHtmlEntities('')).toBe('');
  });
});

describe('isoDay', () => {
  it('formats an ISO timestamp as its UTC day', () => {
    expect(isoDay('2026-10-14T23:30:00.000Z')).toBe('2026-10-14');
    expect(isoDay('2026-10-15T01:00:00+07:00')).toBe('2026-10-14');
  });

  it('returns null for null, empty or unparseable input', () => {
    expect(isoDay(null)).toBeNull();
    expect(isoDay(undefined)).toBeNull();
    expect(isoDay('')).toBeNull();
    expect(isoDay('not a date')).toBeNull();
  });
});
