import { describe, expect, it } from 'vitest';
import {
  PRESENTATION_MAX_ROWS,
  PRESENTATION_ROWS_PER_SLIDE,
  PRESENTATION_TABLE_WIDTH,
  buildPipelinePresentation,
  paginatePresentationRows,
  pipelinePresentationSchema,
  type PresentationSourceColumn,
} from './presentation';

interface Row {
  target: string;
  project_name: string | null;
  stage: string;
  sector: string | null;
  revenue: string;
}

const row = (over: Partial<Row> = {}): Row => ({
  target: 'Acme Chemicals',
  project_name: null,
  stage: 'L1',
  sector: 'Specialty Chemicals',
  revenue: '$312.50M (2025)',
  ...over,
});

const columns: PresentationSourceColumn<Row>[] = [
  { label: 'Stage', text: (r) => r.stage },
  { label: 'Sector', text: (r) => r.sector ?? '' },
  { label: 'Revenue', text: (r) => r.revenue, align: 'right' },
];

describe('buildPipelinePresentation', () => {
  it("lays out No, Company, then exactly the table's open columns, in their order", () => {
    const deck = buildPipelinePresentation(
      [row(), row({ target: 'Beta Foods', stage: 'L0' })],
      columns,
      { subtitle: 'L1 · Inbound' },
    );

    expect(deck.title).toBe('Pipeline Companies');
    expect(deck.subtitle).toBe('L1 · Inbound');
    expect(deck.columns.map((c) => c.label)).toEqual(['No', 'Company', 'Stage', 'Sector', 'Revenue']);
    expect(deck.columns.map((c) => c.align)).toEqual(['left', 'left', 'left', 'left', 'right']);
    expect(deck.rows).toEqual([
      ['1', 'Acme Chemicals', 'L1', 'Specialty Chemicals', '$312.50M (2025)'],
      ['2', 'Beta Foods', 'L0', 'Specialty Chemicals', '$312.50M (2025)'],
    ]);
  });

  it('shows the project name beside the target and a dash for an empty cell', () => {
    const deck = buildPipelinePresentation(
      [row({ project_name: 'Project Blue', sector: null, revenue: '  ' })],
      columns,
      { subtitle: '' },
    );
    expect(deck.rows[0]).toEqual(['1', 'Acme Chemicals (Project Blue)', 'L1', '—', '—']);
  });

  it('fills the slide width, giving wider columns to longer content', () => {
    const deck = buildPipelinePresentation(
      [row({ sector: 'A very long sector description that runs on' })],
      columns,
      { subtitle: '' },
    );
    const total = deck.columns.reduce((s, c) => s + c.width, 0);
    expect(total).toBeCloseTo(PRESENTATION_TABLE_WIDTH, 2);
    const width = (label: string) => deck.columns.find((c) => c.label === label)!.width;
    expect(width('Sector')).toBeGreaterThan(width('Stage'));
  });

  it('with no open columns still presents the companies', () => {
    const deck = buildPipelinePresentation([row()], [], { subtitle: '' });
    expect(deck.columns.map((c) => c.label)).toEqual(['No', 'Company']);
    expect(deck.rows).toEqual([['1', 'Acme Chemicals']]);
  });
});

describe('paginatePresentationRows', () => {
  it('cuts rows into slide-sized pages and keeps an empty table as one page', () => {
    const rows = Array.from({ length: PRESENTATION_ROWS_PER_SLIDE * 2 + 1 }, (_, i) => [String(i)]);
    const pages = paginatePresentationRows(rows);
    expect(pages.map((p) => p.length)).toEqual([PRESENTATION_ROWS_PER_SLIDE, PRESENTATION_ROWS_PER_SLIDE, 1]);
    expect(paginatePresentationRows([])).toEqual([[]]);
  });
});

describe('pipelinePresentationSchema', () => {
  const deckColumns = [
    { label: 'No', align: 'left', width: 0.45 },
    { label: 'Company', align: 'left', width: 3 },
  ];

  it('accepts a deck whose rows match its columns', () => {
    const deck = { title: 'T', subtitle: '', columns: deckColumns, rows: [['1', 'Acme']] };
    expect(pipelinePresentationSchema.safeParse(deck).success).toBe(true);
  });

  it('rejects mismatched rows, a blank title, an over-wide table, no columns, or too many rows', () => {
    const base = { title: 'T', subtitle: '', columns: deckColumns, rows: [] as string[][] };
    const bad = [
      { ...base, rows: [['1']] },
      { ...base, title: ' ' },
      { ...base, columns: [{ label: 'X', align: 'left', width: 12 }, { label: 'Y', align: 'left', width: 2 }] },
      { ...base, columns: [] },
      { ...base, rows: Array.from({ length: PRESENTATION_MAX_ROWS + 1 }, () => ['1', 'A']) },
    ];
    for (const deck of bad) expect(pipelinePresentationSchema.safeParse(deck).success).toBe(false);
  });
});
