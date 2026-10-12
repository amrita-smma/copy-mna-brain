import { describe, it, expect } from 'vitest';
import { generateResearchSummaryPdf } from '@/lib/pdfSummary';
import { gotoDocument, kitchenSinkDocument } from './testFixtures';
import {
  colorAt,
  extractTextLines,
  linesOutsideContentBox,
  linesOutsideBodyBand,
  findCollisions,
  describe as describeLine,
} from './layoutInspector';
import { COLOR, PAGE } from './theme';
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

  it('carries the column rules through the empty cells of a short last row', async () => {
    // Four cards against a three-wide grid. The second row holds one card and
    // two empty cells; the row's own fill already reaches the right margin, so
    // what the empty cells are actually for is the two interior rules. Without
    // them the grid loses its columns halfway down and the last row reads as a
    // separate, wider box. Only a pixel can see a rule, so this reads some.
    const buffer = await generateResearchSummaryPdf({
      title: 'KPI grid',
      sections: [
        {
          kind: 'kpi_cards',
          cards: [
            { label: 'Revenue', value: '$14.5M' },
            { label: 'EBITDA', value: '$1.8M' },
            { label: 'Margin', value: '~12.4%' },
            { label: 'Stage', value: 'L0' },
          ],
        },
      ],
    });
    const stage = extractTextLines(buffer).find((l) => l.text === 'STAGE');
    expect(stage).toBeDefined();
    const y = stage!.y + stage!.height / 2;

    // A hairline is antialiased across a point or two, so each probe takes the
    // darkest pixel in a small window rather than one exact column.
    const ink = (hex: string) =>
      [1, 3, 5].reduce((sum, i) => sum + parseInt(hex.slice(i, i + 2), 16), 0);
    const darkest = (centre: number) =>
      Math.min(
        ...[-1, -0.5, 0, 0.5, 1].map((d) => ink(colorAt(buffer, 1, centre + d, y))),
      );

    const cell = (PAGE.width - PAGE.marginX * 2) / 3;
    const tint = ink(COLOR.cardBg);

    // Both interior rules are present...
    expect(darkest(PAGE.marginX + cell)).toBeLessThan(tint - 20);
    expect(darkest(PAGE.marginX + cell * 2)).toBeLessThan(tint - 20);
    // ...and the probe is not simply finding ink everywhere: mid-cell is tint.
    expect(darkest(PAGE.marginX + cell * 2.5)).toBe(tint);
  }, 60000);

  it('sets a toned KPI value as a pill rather than as a headline number', async () => {
    const buffer = await generateResearchSummaryPdf({
      title: 'KPI grid',
      sections: [
        {
          kind: 'kpi_cards',
          cards: [{ label: 'Status', value: 'Dropped', tone: 'negative' }],
        },
      ],
    });
    const value = extractTextLines(buffer).find((l) => l.text === 'Dropped');
    expect(value).toBeDefined();

    // Inside the pill's left padding, which is solid fill.
    expect(colorAt(buffer, 1, value!.x - 2.5, value!.y + value!.height / 2)).toBe(
      COLOR.pillNegativeBg,
    );
  }, 60000);

  it('wraps a callout body and its bullets rather than clipping them', async () => {
    const lines = await inspect({
      title: 'Callouts',
      sections: [
        {
          kind: 'callout',
          tone: 'warning',
          title: 'Data verification note',
          text: 'A body long enough that it cannot sit on one line of the box it is in, which is the case the previous renderer silently clipped.',
          items: ['First bullet, also long enough to need a second line of its own.', 'Second.'],
        },
      ],
    });
    const joined = lines.map((l) => l.text).join(' ');
    // Small caps come from `textTransform`, so the drawn string is uppercase.
    expect(joined).toContain('DATA VERIFICATION NOTE');
    expect(joined).toContain('silently clipped');
    expect(joined).toContain('a second line of its own');
    expect(joined).toContain('Second.');
  }, 60000);

  it('keeps a takeaway panel’s fill on the page it continues onto', async () => {
    // The panel is inverted — white text on navy — so a continuation that kept
    // the text and lost the background would print white on white. Text
    // extraction cannot see that, which is why this one reads a pixel.
    const items = Array.from(
      { length: 26 },
      (_, i) =>
        `Takeaway ${i + 1}: a panel item long enough to wrap onto a second line, repeated until the panel has to break across a page.`,
    );
    const input: ResearchSummaryPdfInput = {
      title: 'Takeaways',
      sections: [{ kind: 'callout', tone: 'takeaway', title: 'Takeaways', items }],
    };
    const buffer = await generateResearchSummaryPdf(input);
    const lines = extractTextLines(buffer);

    const continued = lines.filter((l) => l.page === 2 && /^Takeaway \d+:/.test(l.text));
    expect(continued.length).toBeGreaterThan(0);

    // Just left of the first continued line's ink, inside the panel's padding.
    const probe = continued[0];
    expect(colorAt(buffer, 2, probe.x - 6, probe.y + probe.height / 2)).toBe(COLOR.brandNavy);
  }, 60000);

  it('drops a callout carrying neither text nor items instead of boxing nothing', async () => {
    const lines = await inspect({
      title: 'Empty callout',
      sections: [
        { kind: 'callout', tone: 'info', title: 'Nothing to say' },
        { kind: 'paragraph', text: 'The only body content.' },
      ],
    });
    const joined = lines.map((l) => l.text).join(' ');
    expect(joined).toContain('The only body content.');
    expect(joined).not.toContain('NOTHING TO SAY');
  }, 60000);

  it('prints a donut legend with a value and a share for every slice', async () => {
    const lines = await inspect({
      title: 'Donut',
      sections: [
        {
          kind: 'chart',
          type: 'pie',
          title: 'Market share',
          unit: 'USD M',
          categories: ['Thailand', 'Indonesia', 'Malaysia'],
          series: [{ name: 'IAP revenue', values: [162, 118, 103] }],
        },
      ],
    });
    const joined = lines.map((l) => l.text).join(' ');
    for (const label of ['Thailand', 'Indonesia', 'Malaysia']) {
      expect(joined).toContain(label);
    }
    for (const value of ['162', '118', '103']) {
      expect(joined).toContain(value);
    }
    // 162 / 383 — the share is computed from the slice, not restated by the agent.
    expect(joined).toContain('42.3%');
    // The total belongs in the hole; nothing else in the document states it.
    expect(joined).toContain('383');
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
