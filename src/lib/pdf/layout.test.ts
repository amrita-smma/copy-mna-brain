import { describe, it, expect } from 'vitest';
import { generateResearchSummaryPdf } from '@/lib/pdfSummary';
import { gotoDocument, kitchenSinkDocument } from './testFixtures';
import {
  extractTextLines,
  linesOutsideContentBox,
  linesOutsideBodyBand,
  findCollisions,
  describe as describeLine,
} from './layoutInspector';
import type { ResearchSummaryPdfInput } from './types';

/**
 * The regression test for the reported bug: a research-summary PDF whose text
 * overlapped, ran past the right margin, and was silently truncated.
 *
 * These assertions are made against the rendered bytes, not against the React
 * tree, so they hold whatever the layout engine decides to do.
 */
async function inspect(input: ResearchSummaryPdfInput) {
  const buffer = await generateResearchSummaryPdf(input);
  expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  return extractTextLines(buffer);
}

const FIXTURES: Array<[string, ResearchSummaryPdfInput]> = [
  ['the reported GoTo summary', gotoDocument],
  ['a document using every block kind, each over-filled', kitchenSinkDocument],
];

describe('rendered layout invariants', () => {
  for (const [name, fixture] of FIXTURES) {
    describe(name, () => {
      it('draws no text outside the printable area', async () => {
        const lines = await inspect(fixture);
        expect(lines.length).toBeGreaterThan(20);
        const outside = linesOutsideContentBox(lines);
        expect(outside.map(describeLine)).toEqual([]);
      }, 60000);

      it('draws no two lines on top of each other', async () => {
        const lines = await inspect(fixture);
        const collisions = findCollisions(lines);
        expect(
          collisions.map((c) => `${describeLine(c.a)}  ||  ${describeLine(c.b)}`),
        ).toEqual([]);
      }, 60000);

      it('keeps body content out of the running header and footer bands', async () => {
        const lines = await inspect(fixture);
        // The chrome is the only content allowed in those bands.
        const chrome = new Set(
          [fixture.title, fixture.subtitle, 'Investment Brain'].filter(
            (t): t is string => Boolean(t),
          ),
        );
        expect(linesOutsideBodyBand(lines, chrome).map(describeLine)).toEqual([]);

        // The band bounds have to be real for the assertion above to mean
        // anything: without the exclusion, the chrome itself must be flagged.
        expect(linesOutsideBodyBand(lines, new Set()).length).toBeGreaterThan(0);
      }, 60000);
    });
  }

  it('keeps every KPI hint and value intact rather than clipping to one line', async () => {
    const lines = await inspect(gotoDocument);
    const joined = lines.map((l) => l.text).join(' ');
    // The reported PDF delivered these two truncated.
    expect(joined).toContain('Meituan ~19x');
    expect(joined).toContain('Two consecutive profitable quarters');
  }, 60000);

  it('repeats the scorecard header on every page the table spans', async () => {
    const lines = await inspect(kitchenSinkDocument);
    const headerPages = new Set(
      lines.filter((l) => l.text === 'Criterion').map((l) => l.page),
    );
    expect(headerPages.size).toBeGreaterThan(1);
  }, 60000);

  it('numbers every page', async () => {
    const lines = await inspect(kitchenSinkDocument);
    const numbers = lines.filter((l) => /^\d+ \/ \d+$/.test(l.text));
    const total = Number(numbers[0].text.split(' / ')[1]);
    expect(numbers).toHaveLength(total);
    expect(new Set(numbers.map((l) => l.page)).size).toBe(total);
  }, 60000);

  it('renders text outside Latin-1 as itself, not as a replacement glyph', async () => {
    // Includes a legitimate question mark: the old renderer turned every
    // non-WinAnsi codepoint into one, so asserting on an exact round trip is
    // what distinguishes "survived" from "was replaced".
    const text = 'café Łódź Ångström ≥ 95% ±3pp 12 × 4 €1.2bn ₹450cr → “quoted” — what then?';
    const lines = await inspect({
      title: 'Unicode',
      sections: [{ kind: 'paragraph', text }],
    });
    const paragraph = lines.find((l) => l.text.startsWith('café'));
    expect(paragraph?.text).toBe(text);
  }, 60000);

  it('never splits a scorecard row across a page break', async () => {
    const lines = await inspect(kitchenSinkDocument);
    // Each of the three cells in a row is stamped with the row number
    // ("Criterion 7 …", "PASS 7", "Row 7: …"), so a row that lands on two pages
    // shows up as a row number seen on two pages. Matching only the label would
    // pass even when the pill and notes were left behind on the previous page.
    const pagesByRow = new Map<string, Set<number>>();
    for (const line of lines) {
      const match = /^Criterion (\d+) |^Row (\d+):|^(\d+) (?:PASS|NEEDS WORK|CONDITIONALLY)/.exec(
        line.text,
      );
      if (!match) continue;
      const row = match[1] ?? match[2] ?? match[3];
      const pages = pagesByRow.get(row) ?? new Set<number>();
      pages.add(line.page);
      pagesByRow.set(row, pages);
    }
    expect(pagesByRow.size).toBe(30);
    // Every cell of a row must have been seen (label + pill + notes), so the
    // check cannot pass by only ever finding one of the three.
    const split = [...pagesByRow.entries()].filter(([, pages]) => pages.size > 1);
    expect(split.map(([n]) => n)).toEqual([]);
  }, 60000);

  it('finds all three cells of every scorecard row, so the split check is not vacuous', async () => {
    const lines = await inspect(kitchenSinkDocument);
    const texts = lines.map((l) => l.text);
    for (const row of [1, 15, 30]) {
      expect(texts.some((t) => t.startsWith(`Criterion ${row} `))).toBe(true);
      expect(
        texts.some((t) => new RegExp(`^${row} (PASS|NEEDS WORK|CONDITIONALLY)`).test(t)),
      ).toBe(true);
      expect(texts.some((t) => t.startsWith(`Row ${row}:`))).toBe(true);
    }
  }, 60000);
});
