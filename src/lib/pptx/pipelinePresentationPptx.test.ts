import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { getPptxTemplate } from './templates';
import {
  PRESENTATION_LAYOUT,
  MIN_BODY_FONT_SIZE,
  paginateByHeight,
  rowHeight,
  wrappedLineCount,
  pipelinePresentationToPptx,
  presentationFileName,
} from './pipelinePresentationPptx';
import {
  PRESENTATION_ROWS_PER_SLIDE,
  type PipelinePresentation,
  type PresentationColumn,
} from '@/lib/pipeline/presentation';

const STARCAPITAL = getPptxTemplate('starcapital');

const COLUMNS: PresentationColumn[] = [
  { label: 'No', align: 'left', width: 0.45 },
  { label: 'Company', align: 'left', width: 3 },
  { label: 'Stage', align: 'left', width: 1.2 },
  { label: 'Deal Lead', align: 'left', width: 2 },
  { label: 'Revenue', align: 'right', width: 2 },
];

const row = (i: number, columns = COLUMNS) =>
  columns.map((c) => (c.label === 'No' ? String(i) : `${c.label} ${i}`));

const deck = (count: number, columns = COLUMNS): PipelinePresentation => ({
  title: 'Pipeline Companies',
  subtitle: 'L1 · Inbound',
  columns,
  rows: Array.from({ length: count }, (_, i) => row(i + 1, columns)),
});

async function slidesOf(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  return {
    zip,
    slides: await Promise.all(names.map((n) => zip.file(n)!.async('string'))),
  };
}

describe('pipelinePresentationToPptx', () => {
  it('paginates the rows into slides with a header row on each', async () => {
    const { slides } = await slidesOf(await pipelinePresentationToPptx(deck(PRESENTATION_ROWS_PER_SLIDE + 3), STARCAPITAL));

    expect(slides).toHaveLength(2);
    for (const slide of slides) {
      expect(slide).toContain('<a:tbl>');
      expect(slide).toContain('Deal Lead');
      expect(slide).toContain('Pipeline Companies');
    }
    expect(slides[0]).toContain(`Companies 1–${PRESENTATION_ROWS_PER_SLIDE} of ${PRESENTATION_ROWS_PER_SLIDE + 3} (1/2)`);
    expect(slides[1]).toContain(`Company ${PRESENTATION_ROWS_PER_SLIDE + 3}`);
    expect(slides[1]).not.toContain(`Company 1<`);
  });

  it("draws the table in the template's syntax: navy header, grey rules, Arial", async () => {
    const { slides } = await slidesOf(await pipelinePresentationToPptx(deck(2), STARCAPITAL));
    const slide = slides[0];

    expect(slide).toContain(PRESENTATION_LAYOUT.table.headerFill);
    expect(slide).toContain(PRESENTATION_LAYOUT.table.rule);
    expect(slide).toContain('typeface="Arial"');
  });

  it("uses only the deck's columns, and steps the type down a point for a wide table", async () => {
    const narrow = (await slidesOf(await pipelinePresentationToPptx(deck(1), STARCAPITAL))).slides[0];
    expect(narrow).toContain('Deal Lead');
    expect(narrow).not.toContain('Sector');
    expect(narrow).toContain('sz="1100"'); // 11pt header
    expect(narrow).toContain('sz="1000"'); // 10pt body

    const wideColumns: PresentationColumn[] = Array.from({ length: 12 }, (_, i) => ({
      label: i === 0 ? 'No' : `Col${i}`,
      align: 'left',
      width: 1,
    }));
    const wide = (await slidesOf(await pipelinePresentationToPptx(deck(1, wideColumns), STARCAPITAL))).slides[0];
    expect(wide).toContain('sz="900"'); // 9pt body
    expect(wide).not.toContain('sz="1100"'); // header down to 10pt
  });

  it('puts every slide on the StarCapital master (logo media in the deck)', async () => {
    const { zip } = await slidesOf(await pipelinePresentationToPptx(deck(1), STARCAPITAL));
    expect(Object.keys(zip.files).some((f) => /^ppt\/media\/.+\.png$/.test(f))).toBe(true);
  });

  it('on the Default template, writes plain slides: no logo, no branding, a page number of its own', async () => {
    const buffer = await pipelinePresentationToPptx(deck(PRESENTATION_ROWS_PER_SLIDE + 1), null);
    const { zip, slides } = await slidesOf(buffer);

    expect(Object.keys(zip.files).some((f) => /^ppt\/media\//.test(f) && !f.endsWith('/'))).toBe(false);
    expect(slides).toHaveLength(2);
    for (const slide of slides) {
      expect(slide).not.toContain('STRICTLY PRIVATE AND CONFIDENTIAL');
      expect(slide).toContain('type="sldNum"');
      // The table keeps the template's table syntax.
      expect(slide).toContain(PRESENTATION_LAYOUT.table.headerFill);
    }
    const masters = await Promise.all(
      Object.keys(zip.files)
        .filter((f) => /^ppt\/slideLayouts\/.+\.xml$/.test(f))
        .map((f) => zip.file(f)!.async('string')),
    );
    expect(masters.join('')).not.toContain('STARCAPITAL');
  });

  it('still writes one slide saying nothing matched when there are no rows', async () => {
    const { slides } = await slidesOf(await pipelinePresentationToPptx(deck(0), STARCAPITAL));
    expect(slides).toHaveLength(1);
    expect(slides[0]).toContain('No companies match the current view.');
  });
});

describe('wrappedLineCount', () => {
  it('keeps short text on one line and wraps longer text onto more', () => {
    expect(wrappedLineCount('Acme', 2.4, 10)).toBe(1);
    const long = 'A very long company name that cannot possibly fit on one line of a narrow column';
    expect(wrappedLineCount(long, 1, 10)).toBeGreaterThan(3);
  });

  it('breaks a word wider than the column and honours explicit newlines', () => {
    expect(wrappedLineCount('x'.repeat(200), 1, 10)).toBeGreaterThan(5);
    expect(wrappedLineCount('one\ntwo\nthree', 3, 10)).toBe(3);
  });
});

describe('rowHeight and paginateByHeight', () => {
  it('grows a row to its tallest wrapped cell, never below the minimum', () => {
    expect(rowHeight(['a', 'b'], [1, 1], 10, 0.36)).toBe(0.36);
    expect(rowHeight(['a', 'word '.repeat(60)], [1, 1], 10, 0.36)).toBeGreaterThan(1);
  });

  it('starts a new slide when the next row would overflow, and gives an oversized row its own', () => {
    const rows = [['1'], ['2'], ['3'], ['4']];
    const pages = paginateByHeight(rows, [1, 1, 5, 1], 2.5);
    expect(pages.map((p) => p.rows.length)).toEqual([2, 1, 1]);
  });
});

describe('full row content', () => {
  const longRemark = 'Strategic rationale: '.concat('the target has a durable franchise and expanding margins. '.repeat(8), 'END-OF-REMARK');

  it('wraps a long cell onto several lines instead of clipping it', async () => {
    const d = deck(1);
    d.rows[0][2] = longRemark;
    const { slides } = await slidesOf(await pipelinePresentationToPptx(d, STARCAPITAL));
    expect(slides[0]).toContain('END-OF-REMARK');
    expect(slides[0]).not.toContain('…');
  });

  it('paginates by height so tall rows spill to more slides than 12 short ones', async () => {
    const d = deck(PRESENTATION_ROWS_PER_SLIDE);
    d.rows.forEach((r) => { r[2] = longRemark; });
    const { slides } = await slidesOf(await pipelinePresentationToPptx(d, STARCAPITAL));
    expect(slides.length).toBeGreaterThan(1);
    expect(slides.join('')).toContain('END-OF-REMARK');
  });

  it('steps the type down for a single row too tall for one slide, never below the minimum', async () => {
    const d = deck(1);
    d.rows[0][2] = 'word '.repeat(400);
    const { slides } = await slidesOf(await pipelinePresentationToPptx(d, STARCAPITAL));
    expect(slides).toHaveLength(1);
    expect(slides[0]).not.toContain('sz="1000"');
    expect(slides[0]).toMatch(new RegExp(`sz="(${MIN_BODY_FONT_SIZE}|[7-9])00"`));
  });
});

describe('presentationFileName', () => {
  it('slugs the title and dates the file', () => {
    expect(presentationFileName(deck(0), new Date('2026-10-28T12:00:00Z'))).toBe(
      'pipeline-companies-2026-10-28.pptx',
    );
  });
});
