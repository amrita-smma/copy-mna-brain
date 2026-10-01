import { describe, it, expect } from 'vitest';
import { checkTemplateHtml, NO_SECTIONS_WARNING } from './templateCheck';
import { INSIGHT_TEMPLATE_MAX_CHARS } from './templateAttachment';

const doc = (body: string) => `<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`;

describe('checkTemplateHtml', () => {
  it('passes a complete document with data-section keys with no errors or warnings', () => {
    expect(checkTemplateHtml(doc('<section data-section="summary"><h2>Summary</h2></section>'))).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   \n\t '],
  ])('errors on %s', (_label, html) => {
    expect(checkTemplateHtml(html)).toEqual({ errors: ['The file is empty.'], warnings: [] });
  });

  it('errors with the real size when over the character cap', () => {
    const html = doc('x'.repeat(285_000));
    const result = checkTemplateHtml(html);

    expect(result.errors).toEqual([
      `Template is ${html.length.toLocaleString('en-US')} characters; templates are limited to 250,000.`,
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('accepts a document exactly at the character cap', () => {
    const shell = doc('<div data-section="a"></div>');
    const html = shell + ' '.repeat(INSIGHT_TEMPLATE_MAX_CHARS - shell.length);
    expect(html.length).toBe(INSIGHT_TEMPLATE_MAX_CHARS);
    expect(checkTemplateHtml(html).errors).toEqual([]);
  });

  it('warns, without erroring, when no element carries data-section', () => {
    const result = checkTemplateHtml(doc('<h1>Brief</h1><p>Body</p>'));

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([NO_SECTIONS_WARNING]);
    expect(NO_SECTIONS_WARNING).toContain(
      "Copilot can build from it, but section edits and refresh can't target sections.",
    );
  });

  it('does not count data-section text inside a script or a similarly named attribute', () => {
    const html = doc(
      `<div data-section-title="x">A</div><script>const s = '<div data-section="fake">';</script>`,
    );
    expect(checkTemplateHtml(html).warnings).toContain(NO_SECTIONS_WARNING);
  });

  it('warns on an unclosed <html>', () => {
    const result = checkTemplateHtml('<html><body><section data-section="a">A</section></body>');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(['The <html> tag is never closed, so the file may be cut off.']);
  });

  it('warns on an unclosed <body>', () => {
    const result = checkTemplateHtml('<html><body><section data-section="a">A</section></html>');
    expect(result.warnings).toEqual(['The <body> tag is never closed, so the file may be cut off.']);
  });

  it('ignores <html>/<body> text inside comments and scripts', () => {
    const html = doc(
      '<!-- <html> --><script>document.write("<body>")</script><section data-section="a">A</section>',
    );
    expect(checkTemplateHtml(html).warnings).toEqual([]);
  });

  it('warns on an empty body', () => {
    const result = checkTemplateHtml('<html><head><style>p{}</style></head><body>  </body></html>');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([
      'The document body is empty, so it renders blank.',
      NO_SECTIONS_WARNING,
    ]);
  });

  it('accepts a fragment with no <html>/<body> wrapper', () => {
    expect(checkTemplateHtml('<section data-section="a"><p>A</p></section>')).toEqual({
      errors: [],
      warnings: [],
    });
  });
});
