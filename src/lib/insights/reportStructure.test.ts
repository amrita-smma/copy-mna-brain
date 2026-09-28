import { describe, it, expect } from 'vitest';
import { validateReportStructure } from './reportStructure';
import { generateWords, makeValidReport } from './testFixtures';

const sec = (key: string, body = '') => `<section data-section="${key}">${body}</section>`;
const p = (n: number) => `<p>${generateWords(n)}</p>`;
const COUNTER_CASE = `<div data-counter-case>${p(45)}</div>`;
const withDetails = (detailsContent: string) =>
  validateReportStructure(makeValidReport({ detailsContent }));
const vizError = (tag: string, section = 'details') =>
  `visualisation block <${tag}> in the ${section} section must have an interpreting text block (<p>, <ul>, <ol>) with at least 15 words immediately before or after it.`;
const OUT_OF_ORDER = 'sections are out of order; expected summary, details, and appendix in document order.';
const NO_COUNTER_CASE = 'the details section must contain an element carrying a data-counter-case attribute.';

describe('validateReportStructure', () => {
  it('returns null for a completely valid report document', () => {
    expect(validateReportStructure(makeValidReport())).toBeNull();
  });

  describe('Rule 1: Three sections', () => {
    it.each([
      ['summary', sec('details') + sec('appendix')],
      ['details', sec('summary') + sec('appendix')],
      ['appendix', sec('summary') + sec('details')],
    ])('rejects a document missing the %s section', (section, html) => {
      expect(validateReportStructure(html)).toBe(
        `the document is missing a <section data-section="${section}"> section.`,
      );
    });

    it.each(['summary', 'details', 'appendix'])('rejects duplicate %s sections', (section) => {
      const html = ['summary', 'details', 'appendix']
        .map((k) => (k === section ? sec(k) + sec(k) : sec(k)))
        .join('');
      expect(validateReportStructure(html)).toBe(
        `the document contains multiple <section data-section="${section}"> sections; exactly one is required.`,
      );
    });

    it('rejects sections out of order', () => {
      expect(validateReportStructure(sec('details') + sec('summary') + sec('appendix'))).toBe(OUT_OF_ORDER);
    });

    it('accepts a keyed sub-section inside details (nested section passing)', () => {
      const html = makeValidReport({
        detailsContent: `<h2>Overview</h2>${COUNTER_CASE}
          <section data-section="valuation-bridge">${p(20)}<table><tr><td>V</td></tr></table>${p(20)}</section>`,
      });
      expect(validateReportStructure(html)).toBeNull();
    });

    it('rejects when a nested section does not satisfy a missing top-level section', () => {
      const html = sec('summary', p(180) + sec('details', COUNTER_CASE)) + sec('appendix', p(20));
      expect(validateReportStructure(html)).toBe('the document is missing a <section data-section="details"> section.');
    });

    it('rejects unclosed sections', () => {
      const html = `<section data-section="summary">${p(180)}` + sec('details', COUNTER_CASE) + sec('appendix', p(20));
      expect(validateReportStructure(html)).toContain('sections are unclosed');
    });

    it.each([
      ['a methodology section', `<section data-section="methodology"><h2>Methodology</h2>${p(50)}</section>`],
      ['a section with no data-section attribute', `<section><h2>Intro</h2>${p(50)}</section>`],
    ])('accepts an extra top-level section: %s', (_, extra) => {
      const html = makeValidReport().replace(
        '<section data-section="summary">',
        `${extra}<section data-section="summary">`,
      );
      expect(validateReportStructure(html)).toBeNull();
    });

    it('enforces relative order of the three required sections even with extra top-level sections', () => {
      const html = sec('methodology') + sec('details') + sec('summary') + sec('appendix');
      expect(validateReportStructure(html)).toBe(OUT_OF_ORDER);
    });
  });

  describe('Rule 2: Summary length', () => {
    it.each([149, 251])('rejects a summary of %i words', (n) => {
      expect(validateReportStructure(makeValidReport({ summaryContent: p(n) }))).toBe(
        `the Summary section is ${n} words; it must be between 150 and 250.`,
      );
    });

    it.each([150, 250])('accepts a summary of exactly %i words', (n) => {
      expect(validateReportStructure(makeValidReport({ summaryContent: p(n) }))).toBeNull();
    });

    it('correctly counts words when HTML tags and multiple spaces are present', () => {
      const tagged = generateWords(160)
        .split(' ')
        .map((w, i) => (i % 10 === 0 ? `<strong>${w}</strong>` : w))
        .join('    \n');
      expect(validateReportStructure(makeValidReport({ summaryContent: `<div>${tagged}</div>` }))).toBeNull();
    });
  });

  describe('Rule 3: Counter-case', () => {
    it('rejects details section without a data-counter-case element', () => {
      expect(withDetails(`<h2>Overview</h2>${p(20)}`)).toBe(NO_COUNTER_CASE);
    });

    it('rejects a counter-case element under 40 words', () => {
      expect(withDetails(`<div data-counter-case>${p(39)}</div>${p(20)}`)).toBe(
        'the counter-case element is 39 words; it must be at least 40 words.',
      );
    });

    it.each([
      ['a div with exactly 40 words', `<div data-counter-case>${p(40)}</div>${p(20)}`],
      ['the attribute directly on a paragraph', `<p data-counter-case="risk">${generateWords(45)}</p>`],
    ])('accepts a counter-case element: %s', (_, details) => {
      expect(withDetails(details)).toBeNull();
    });
  });

  describe('Rule 4: Adjacent interpretation', () => {
    it.each([
      ['a table with only headings around it', 'table', `<h2>A</h2><table><tr><td>D</td></tr></table><h2>B</h2>`],
      ['a table whose adjacent text is under 15 words', 'table', `<h2>A</h2>${p(14)}<table><tr><td>D</td></tr></table><h2>B</h2>`],
      ['a standalone non-decorative svg', 'svg', `<h2>A</h2><svg viewBox="0 0 100 100"><circle r="50"/></svg>`],
    ])('rejects %s', (_, tag, body) => {
      expect(withDetails(COUNTER_CASE + body)).toBe(vizError(tag));
    });

    it.each([
      ['interpreting text immediately before it', `<h2>A</h2>${p(15)}<table><tr><td>D</td></tr></table><h2>B</h2>`],
      ['interpreting text immediately after it', `<h2>A</h2><table><tr><td>D</td></tr></table>${p(15)}`],
      [
        'ul and ol with at least 15 words',
        `<h2>A</h2><ul><li>${generateWords(8)}</li><li>${generateWords(8)}</li></ul><canvas></canvas><ol><li>${generateWords(10)}</li><li>${generateWords(6)}</li></ol>`,
      ],
      [
        'a figure containing an svg treated as a single block',
        `<h2>A</h2>${p(18)}<figure><svg viewBox="0 0 100 100"><circle r="50"/></svg><figcaption>C</figcaption></figure>${p(18)}`,
      ],
    ])('accepts a visualisation block with %s', (_, body) => {
      expect(withDetails(COUNTER_CASE + body)).toBeNull();
    });

    it('rejects an un-interpreted visualisation block in the appendix', () => {
      const html = makeValidReport({ appendixContent: '<h2>Appendix</h2><canvas></canvas>' });
      expect(validateReportStructure(html)).toBe(vizError('canvas', 'appendix'));
    });

    it.each([
      ['nested inside h1-h6 headings', '<h2><svg viewBox="0 0 10 10"><circle r="5"/></svg> Heading</h2>'],
      ['nested inside buttons', '<h2>H</h2><button><svg viewBox="0 0 10 10"><path d="M0 0h10"/></svg> Export</button>'],
      ['nested inside anchor links', '<h2>H</h2><a href="#"><svg viewBox="0 0 10 10"><circle r="5"/></svg> Source</a>'],
      ['carrying data-decorative attribute', '<h2>H</h2><div><svg data-decorative viewBox="0 0 10 10"><circle r="5"/></svg></div>'],
    ])('excludes decorative svg %s', (_, wrapper) => {
      expect(withDetails(`${wrapper}${COUNTER_CASE}${p(20)}<table><tr><td>1</td></tr></table>${p(20)}`)).toBeNull();
    });
  });

  describe('Rule 5: Visualisation ratio', () => {
    it('rejects details section when visualisation ratio exceeds 40%', () => {
      // viz: table, canvas; text: two <p> -> 2 / 4 = 50%
      expect(
        withDetails(`<p data-counter-case>${generateWords(45)}</p><table><tr><td>1</td></tr></table><canvas></canvas>${p(20)}`),
      ).toBe('the details section visualisation ratio is 50%; it must not exceed 40%.');
    });

    it.each(['h2', 'h3'])('accepts exactly 40%%, counting <%s> as a text block', (h) => {
      const body = `<p data-counter-case>${generateWords(45)}</p><table><tr><td>1</td></tr></table>${p(20)}<canvas></canvas>`;
      // viz: table, canvas; text: heading, two <p> -> 2 / 5 = 40%. Without the heading: 2 / 4 = 50%.
      expect(withDetails(`<${h}>H</${h}>${body}`)).toBeNull();
      expect(withDetails(body)).toBe('the details section visualisation ratio is 50%; it must not exceed 40%.');
    });
  });

  describe('Rule execution order', () => {
    it.each([
      ['Rule 1 before Rule 2', sec('summary', '<p>Too short</p>') + sec('details', '<p>x</p>'), 'the document is missing a <section data-section="appendix"> section.'],
      ['Rule 2 before Rule 3', sec('summary', '<p>Too short summary</p>') + sec('details', '<p>x</p>') + sec('appendix', p(20)), 'the Summary section is 3 words; it must be between 150 and 250.'],
      ['Rule 3 before Rule 4', makeValidReport({ detailsContent: '<h2>D</h2><table><tr><td>D</td></tr></table>' }), NO_COUNTER_CASE],
      ['Rule 4 before Rule 5', makeValidReport({ detailsContent: `${COUNTER_CASE}<table><tr><td>D</td></tr></table><canvas></canvas>` }), vizError('canvas')],
    ])('reports %s', (_, html, expected) => {
      expect(validateReportStructure(html)).toBe(expected);
    });
  });

  describe('Draft / incremental sections (MB-565)', () => {
    it.each([
      ['an all-empty skeleton', sec('summary') + sec('details') + sec('appendix')],
      [
        'comment-only and whitespace-only sections',
        sec('summary', '<!-- draft -->') + sec('details', '\n   \n') + sec('appendix', '<!-- a --><!-- b -->'),
      ],
      ['valid summary and details with an empty appendix', sec('summary', p(180)) + sec('details', `<h2>O</h2>${COUNTER_CASE}${p(20)}`) + sec('appendix')],
    ])('accepts %s', (_, html) => {
      expect(validateReportStructure(html)).toBeNull();
    });

    it.each([
      ['a filled summary under 150 words', sec('summary', p(20)) + sec('details') + sec('appendix'), 'the Summary section is 20 words; it must be between 150 and 250.'],
      ['<p></p> in summary as filled', sec('summary', '<p></p>') + sec('details') + sec('appendix'), 'the Summary section is 0 words; it must be between 150 and 250.'],
      ['<p></p> in details as filled', sec('summary') + sec('details', '<p></p>') + sec('appendix'), NO_COUNTER_CASE],
    ])('checks %s beside empty sections', (_, html, expected) => {
      expect(validateReportStructure(html)).toBe(expected);
    });
  });
});
