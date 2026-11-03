import { describe, expect, it } from 'vitest';
import { extractInsightSection, findInsightSection, listInsightSectionKeys, replaceInsightSection } from './sectionEdit';
import { ADVERSARIAL_DOCUMENT, ADVERSARIAL_SECTION } from './__testHelpers';

const replaced = (html: string, key: string, replacement: string) => {
  const result = replaceInsightSection(html, key, replacement);
  if (!result.success) throw new Error(result.error);
  return result.html;
};
const failure = (html: string, key: string, replacement = '<p>new</p>') => {
  const result = replaceInsightSection(html, key, replacement);
  expect(result.success).toBe(false);
  return result.success ? '' : result.error;
};

describe('sectionEdit: replaceInsightSection', () => {
  it('preserves every byte outside the target section of an adversarial document', () => {
    const replacement = `<section data-section="market-overview">
    <h2>Updated Overview</h2>
    <p>New content with data &amp; metrics.</p>
  </section>`;

    expect(replaced(ADVERSARIAL_DOCUMENT, 'market-overview', replacement)).toBe(
      ADVERSARIAL_DOCUMENT.replace(ADVERSARIAL_SECTION, replacement),
    );
  });

  describe('nested keyed blocks', () => {
    const NESTED_DOC = `<div>
  <div data-section="outer-card">
    <h3>Outer Header</h3>
    <section data-section="inner-details">
      <p>Inner content</p>
    </section>
    <p>Outer footer</p>
  </div>
</div>`;

    it('replaces outer block and takes all child elements with it', () => {
      const replacement = '<div data-section="outer-card"><p>Completely new card</p></div>';
      expect(replaced(NESTED_DOC, 'outer-card', replacement)).toBe(`<div>\n  ${replacement}\n</div>`);
    });

    it('replaces only inner block while leaving outer block structure intact', () => {
      const html = replaced(NESTED_DOC, 'inner-details', '<section data-section="inner-details"><p>Updated inner</p></section>');
      expect(html).toContain('<h3>Outer Header</h3>');
      expect(html).toContain('<p>Outer footer</p>');
      expect(html).toContain('<p>Updated inner</p>');
      expect(html).not.toContain('<p>Inner content</p>');
    });
  });

  it('returns a clear failure result without throwing when key does not exist', () => {
    expect(failure('<section data-section="alpha"><p>Alpha</p></section>', 'non-existent')).toBe(
      'Section "non-existent" not found in document.',
    );
  });

  describe('duplicate keys', () => {
    it('fails clearly when target key appears multiple times in the document', () => {
      const error = failure('<div data-section="dup">First</div>\n<div data-section="dup">Second</div>', 'dup');
      expect(error).toContain('Duplicate section key "dup" found (2 occurrences)');
      expect(error).toContain('Section keys must be unique');
    });

    it('succeeds when another section has duplicates but target key is unique', () => {
      const doc = '<div data-section="target">T</div><div data-section="other">O1</div><div data-section="other">O2</div>';
      expect(replaced(doc, 'target', '<div data-section="target">New</div>')).toBe(
        '<div data-section="target">New</div><div data-section="other">O1</div><div data-section="other">O2</div>',
      );
    });
  });

  it.each([
    ['an HTML void tag without closing tag (hr)', '<p>Above</p>', '<hr data-section="k">', '<p>Below</p>'],
    ['an HTML void tag (img)', '<header>', '<img data-section="k" src="/logo.png">', '</header>'],
    ['a self-closing element with />', '<main>', '<div data-section="k" />', '<aside>Side</aside></main>'],
  ])('replaces %s', (_, before, target, after) => {
    const replacement = '<div data-section="k"><p>Filled</p></div>';
    expect(replaced(before + target + after, 'k', replacement)).toBe(before + replacement + after);
  });

  it.each([
    ['double quoted', '<section data-section="k">content</section>'],
    ['single quoted', "<section data-section='k'>content</section>"],
    ['unquoted', '<section data-section=k>content</section>'],
    ['whitespace around =', '<section data-section = "k">content</section>'],
  ])('matches a %s data-section attribute', (_, doc) => {
    expect(replaced(doc, 'k', '<p>new</p>')).toBe('<p>new</p>');
  });

  it('preserves key case and does not match case-insensitively', () => {
    const doc = '<section data-section="ValuationBridge">content</section>';
    failure(doc, 'valuationbridge');
    expect(replaced(doc, 'ValuationBridge', '<p>new</p>')).toBe('<p>new</p>');
  });

  it.each(['article', 'aside', 'div', 'main', 'p', 'table', 'custom-widget'])(
    'matches a <%s> carrying data-section',
    (tag) => {
      expect(replaced(`<${tag} data-section="k">content</${tag}>`, 'k', `<${tag}>replaced</${tag}>`)).toBe(
        `<${tag}>replaced</${tag}>`,
      );
    },
  );

  it('returns an error when target section has an unclosed open tag', () => {
    expect(failure('<div><section data-section="unclosed"><p>Text without closing tag</div>', 'unclosed')).toBe(
      'Unclosed element for section "unclosed".',
    );
  });

  it.each([
    ['html is empty', '', 'key'],
    ['html is whitespace', '   ', 'key'],
    ['sectionKey is empty', '<div>content</div>', ''],
  ])('returns an error when %s', (_, html, key) => {
    failure(html, key);
  });
});

describe('sectionEdit: extractInsightSection', () => {
  const DOC = `<!DOCTYPE html><html><body>
<section data-section="summary"><h2>Summary</h2><p>Up 4%.</p></section>
<section data-section='risks'><ul><li>FX</li></ul></section>
<hr data-section=divider>
</body></html>`;

  it('returns the outer HTML of the keyed block, byte-for-byte', () => {
    const result = extractInsightSection(DOC, 'summary');
    expect(result).toEqual({
      success: true,
      html: '<section data-section="summary"><h2>Summary</h2><p>Up 4%.</p></section>',
    });
  });

  it('round-trips with replaceInsightSection: extracting then splicing back changes nothing', () => {
    const fragment = extractInsightSection(DOC, 'risks');
    if (!fragment.success) throw new Error(fragment.error);
    expect(replaceInsightSection(DOC, 'risks', fragment.html)).toEqual({ success: true, html: DOC });
  });

  it('extracts a self-closing keyed element', () => {
    expect(extractInsightSection(DOC, 'divider')).toEqual({ success: true, html: '<hr data-section=divider>' });
  });

  it('fails with the same reasons as a replace: missing, duplicate, unclosed', () => {
    const missing = extractInsightSection(DOC, 'nope');
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('not found');

    const dup = extractInsightSection(`${DOC}<div data-section="summary"></div>`, 'summary');
    expect(dup.error).toContain('Duplicate section key');

    const unclosed = extractInsightSection('<div><section data-section="open"><p>x</p></div>', 'open');
    expect(unclosed.error).toContain('Unclosed element');
  });

  it('extracts the market-overview section of the adversarial document exactly', () => {
    expect(extractInsightSection(ADVERSARIAL_DOCUMENT, 'market-overview')).toEqual({
      success: true,
      html: ADVERSARIAL_SECTION,
    });
  });
});

describe('sectionEdit: listInsightSectionKeys', () => {
  it('lists every key in document order, nested and self-closing included', () => {
    const html = `<div data-section="outer"><section data-section="inner"></section></div><hr data-section="rule"><p data-section="inner">dup</p>`;
    expect(listInsightSectionKeys(html)).toEqual(['outer', 'inner', 'rule', 'inner']);
  });

  it('includes a key the document never closes, so the reader is still told it exists', () => {
    expect(listInsightSectionKeys('<section data-section="a"></section><div data-section="open">')).toEqual(['a', 'open']);
  });

  it('is empty for an empty document or one with no keys', () => {
    expect(listInsightSectionKeys('')).toEqual([]);
    expect(listInsightSectionKeys('<p>no keys</p>')).toEqual([]);
  });
});

describe('sectionEdit: findInsightSection', () => {
  const DOC = '<body><p>a</p><section data-section="k"><p>b</p></section><p>c</p></body>';

  it('returns the byte span of the keyed block', () => {
    const start = DOC.indexOf('<section');
    const end = DOC.indexOf('</section>') + '</section>'.length;
    expect(findInsightSection(DOC, 'k')).toEqual({ success: true, span: { key: 'k', start, end } });
  });

  it('names the failure: empty document, missing key, duplicate key, unclosed element', () => {
    expect(findInsightSection('', 'k')).toEqual({ success: false, error: 'HTML document is empty or invalid.' });
    expect(findInsightSection(DOC, ' ')).toEqual({ success: false, error: 'Section key is required.' });
    expect(findInsightSection(DOC, 'x')).toEqual({ success: false, error: 'Section "x" not found in document.' });
    expect(findInsightSection(`${DOC}<div data-section="k"></div>`, 'k')).toEqual({
      success: false,
      error: 'Duplicate section key "k" found (2 occurrences). Section keys must be unique.',
    });
    expect(findInsightSection('<div><section data-section="k"><p>x</p></div>', 'k')).toEqual({
      success: false,
      error: 'Unclosed element for section "k".',
    });
  });
});
