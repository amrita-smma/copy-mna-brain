import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { getPptxTemplate } from './templates';
import {
  PRESENTATION_LAYOUT,
  fitCellText,
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

describe('fitCellText', () => {
  it('keeps text that fits and clips longer text to one line with an ellipsis', () => {
    expect(fitCellText('Acme', 2.4, 10)).toBe('Acme');
    const clipped = fitCellText('A very long company name that cannot possibly fit', 1, 10);
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped.length).toBeLessThan(20);
  });
});

describe('presentationFileName', () => {
  it('slugs the title and dates the file', () => {
    expect(presentationFileName(deck(0), new Date('2026-10-28T12:00:00Z'))).toBe(
      'pipeline-companies-2026-10-28.pptx',
    );
  });
});
