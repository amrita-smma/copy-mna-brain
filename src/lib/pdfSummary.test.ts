import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { generateResearchSummaryPdf, type SectionBlock } from './pdfSummary';

function isPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString() === '%PDF-';
}

describe('generateResearchSummaryPdf', () => {
  it('produces a valid PDF with the document title set in metadata', async () => {
    const buffer = await generateResearchSummaryPdf({
      title: 'Test doc',
      sections: [{ kind: 'paragraph', text: 'Hello' }],
    });
    expect(isPdf(buffer)).toBe(true);
    const parsed = await PDFDocument.load(buffer);
    expect(parsed.getTitle()).toBe('Test doc');
    expect(parsed.getPageCount()).toBeGreaterThan(0);
  });

  it('renders just the title page when sections is empty after validation', async () => {
    const buffer = await generateResearchSummaryPdf({
      title: 'Bare doc',
      sections: [],
    });
    expect(isPdf(buffer)).toBe(true);
    expect((await PDFDocument.load(buffer)).getPageCount()).toBe(1);
  });

  it('renders every block kind in a single document without throwing', async () => {
    const sections: SectionBlock[] = [
      { kind: 'heading', text: 'Executive summary' },
      { kind: 'bullets', items: ['Finding A', 'Finding B', 'Finding C'] },
      { kind: 'paragraph', text: 'Recommendation: proceed to L1 diligence with caveats.' },
      { kind: 'heading', text: 'Snapshot' },
      {
        kind: 'kpi_cards',
        cards: [
          { label: 'Revenue', value: '$112M', hint: '+22% YoY' },
          { label: 'EBITDA margin', value: '24%' },
          { label: 'HQ', value: 'Seoul' },
        ],
      },
      {
        kind: 'bar_chart',
        title: 'Revenue',
        unit: 'USD millions',
        data: [
          { year: 'FY22', value: 74 },
          { year: 'FY23', value: 92 },
          { year: 'FY24', value: 112 },
        ],
      },
      {
        kind: 'gauges',
        gauges: [
          { label: 'Gross margin', valuePct: 52, tone: 'positive', trendLabel: 'rising' },
          { label: 'Net margin', valuePct: 14, tone: 'neutral', trendLabel: 'flat' },
        ],
      },
      {
        kind: 'scorecard',
        rows: [
          { label: 'Revenue >= $50M', pill: { label: 'PASS', tone: 'positive' }, rationale: '$112M FY24' },
          {
            label: 'Sponsorable ownership',
            pill: { label: 'FAIL', tone: 'negative' },
            rationale: 'Family-controlled, no event signalled',
          },
        ],
        overallPill: { label: 'PARTIAL', tone: 'warning' },
        overallNote: 'fits financially but ownership is a blocker',
      },
      {
        kind: 'quadrants',
        quadrants: {
          topLeft: ['Regulatory exposure'],
          topRight: ['Customer concentration'],
          bottomLeft: [],
          bottomRight: ['FX exposure'],
          xLabelLow: 'Low likelihood',
          xLabelHigh: 'High likelihood',
          yLabelHigh: 'High impact',
          yLabelLow: 'Low impact',
        },
      },
      {
        kind: 'priority_list',
        items: [
          {
            priority: { label: 'P1', tone: 'high' },
            description: 'Refresh financial diligence',
            meta: 'Owner: Workforce - this week',
          },
          {
            priority: { label: 'WATCH', tone: 'low' },
            description: 'Confirm sponsor appetite',
          },
        ],
      },
    ];

    const buffer = await generateResearchSummaryPdf({
      title: 'Full block sampler',
      subtitle: 'Prepared 2025-06-08',
      sections,
      references: [
        { name: 'Q1 board memo', link: 'https://example.com/memo', date: '2025-03-01' },
        { name: 'Industry report', link: null, date: null },
      ],
    });

    expect(isPdf(buffer)).toBe(true);
    const parsed = await PDFDocument.load(buffer);
    expect(parsed.getPageCount()).toBeGreaterThan(0);
  });

  it('supports the SWOT use case via custom quadrant axis labels', async () => {
    const buffer = await generateResearchSummaryPdf({
      title: 'SWOT - Beta Corp',
      sections: [
        {
          kind: 'quadrants',
          quadrants: {
            topLeft: ['Strong gross margin'],
            topRight: ['Heavy customer concentration'],
            bottomLeft: ['Adjacent market expanding'],
            bottomRight: ['Looming export controls'],
            xLabelLow: 'Positive',
            xLabelHigh: 'Negative',
            yLabelHigh: 'Internal',
            yLabelLow: 'External',
          },
        },
      ],
    });
    expect(isPdf(buffer)).toBe(true);
  });

  it('supports daily-market-update use case with kpi cards + bullets + priority list', async () => {
    const buffer = await generateResearchSummaryPdf({
      title: 'Daily market update',
      sections: [
        {
          kind: 'kpi_cards',
          cards: [
            { label: 'S&P 500', value: '5,432', hint: '+0.4%' },
            { label: 'KOSPI', value: '2,684', hint: '-0.2%' },
          ],
        },
        { kind: 'heading', text: 'Top stories' },
        { kind: 'bullets', items: ['Story 1', 'Story 2'] },
        {
          kind: 'priority_list',
          items: [
            { priority: { label: 'WATCH', tone: 'high' }, description: 'Earnings this week' },
            { priority: { label: 'FYI', tone: 'low' }, description: 'TAM refresh' },
          ],
        },
      ],
    });
    expect(isPdf(buffer)).toBe(true);
  });

  it('renders all five pill tones in a scorecard', async () => {
    const buffer = await generateResearchSummaryPdf({
      title: 'Pill tones',
      sections: [
        {
          kind: 'scorecard',
          rows: [
            { label: 'Row 1', pill: { label: 'POSITIVE', tone: 'positive' }, rationale: 'a' },
            { label: 'Row 2', pill: { label: 'NEGATIVE', tone: 'negative' }, rationale: 'b' },
            { label: 'Row 3', pill: { label: 'NEUTRAL', tone: 'neutral' }, rationale: 'c' },
            { label: 'Row 4', pill: { label: 'WARNING', tone: 'warning' }, rationale: 'd' },
            { label: 'Row 5', pill: { label: 'INFO', tone: 'info' }, rationale: 'e' },
          ],
        },
      ],
    });
    expect(isPdf(buffer)).toBe(true);
  });

  it('embeds Unicode rather than replacing it, now that Inter is embedded', async () => {
    const buffer = await generateResearchSummaryPdf({
      title: 'Unicode test',
      sections: [
        {
          kind: 'scorecard',
          rows: [
            {
              label: 'Revenue ≥ $50M',
              pill: { label: 'PASS', tone: 'positive' },
              rationale: 'Hit $112M — well above the bar. Café, Łódź, ₹450cr.',
            },
          ],
        },
      ],
    });
    expect(isPdf(buffer)).toBe(true);
    // See `pdf/layout.test.ts` for the assertion that the glyphs survive the
    // round trip; the standard-14 `?` substitution is gone.
  });

  it('renders the new chart block in each of its four forms', async () => {
    for (const type of ['bar', 'stacked_bar', 'line', 'pie'] as const) {
      const buffer = await generateResearchSummaryPdf({
        title: `Chart — ${type}`,
        sections: [
          {
            kind: 'chart',
            type,
            title: 'Revenue mix',
            unit: 'USD m',
            categories: ['FY23', 'FY24', 'FY25'],
            series: [
              { name: 'Core', values: [10, 14, 19] },
              { name: 'Adjacent', values: [4, 6, 9] },
            ],
          },
        ],
      });
      expect(isPdf(buffer)).toBe(true);
    }
  });

  it('skips an image block whose url could not be fetched rather than failing', async () => {
    const buffer = await generateResearchSummaryPdf({
      title: 'Dead image',
      sections: [
        { kind: 'image', url: 'https://example.invalid/none.png', caption: 'Nothing here' },
        { kind: 'paragraph', text: 'The rest of the document still renders.' },
      ],
    });
    expect(isPdf(buffer)).toBe(true);
  }, 30000);

  it('renders a scorecard row whose logo url is unreachable, minus the logo', async () => {
    const buffer = await generateResearchSummaryPdf({
      title: 'Dead logo',
      sections: [
        {
          kind: 'scorecard',
          rows: [
            {
              label: 'Acme',
              logoUrl: 'https://example.invalid/logo.png',
              pill: { label: 'PASS', tone: 'positive' },
              rationale: 'Still rendered.',
            },
          ],
        },
      ],
    });
    expect(isPdf(buffer)).toBe(true);
  }, 30000);

  it('renders charts where one bar is negative without crashing', async () => {
    const buffer = await generateResearchSummaryPdf({
      title: 'Negative bar',
      sections: [
        {
          kind: 'bar_chart',
          title: 'Net income',
          data: [
            { year: 'FY22', value: -3 },
            { year: 'FY23', value: 5 },
            { year: 'FY24', value: 12 },
          ],
        },
      ],
    });
    expect(isPdf(buffer)).toBe(true);
  });

  it('spans onto additional pages when many blocks overflow', async () => {
    const sections: SectionBlock[] = Array.from({ length: 30 }, (_, i) => ({
      kind: 'priority_list',
      items: [
        {
          priority: { label: 'P1', tone: 'high' },
          description: `Item ${i + 1} with enough text to wrap onto multiple lines if needed.`,
        },
      ],
    }));
    const buffer = await generateResearchSummaryPdf({ title: 'Overflow', sections });
    expect((await PDFDocument.load(buffer)).getPageCount()).toBeGreaterThan(1);
  });

  it('renders empty quadrants as "(none)" placeholders', async () => {
    const buffer = await generateResearchSummaryPdf({
      title: 'Empty quadrants',
      sections: [
        {
          kind: 'quadrants',
          quadrants: {
            topLeft: [],
            topRight: [],
            bottomLeft: [],
            bottomRight: [],
          },
        },
      ],
    });
    expect(isPdf(buffer)).toBe(true);
  });

  it('renders an optional references section after the sections', async () => {
    const buffer = await generateResearchSummaryPdf({
      title: 'With refs',
      sections: [{ kind: 'paragraph', text: 'Body' }],
      references: [
        { name: 'Memo A', link: 'https://example.com', date: '2025-01-01' },
        { name: 'Memo B' },
      ],
    });
    expect(isPdf(buffer)).toBe(true);
  });
});
