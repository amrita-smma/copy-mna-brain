import { describe, it, expect } from 'vitest';
import { generateResearchSummaryPdf } from '@/lib/pdfSummary';
import { gotoDocument, kitchenSinkDocument } from './testFixtures';
import { pageCount } from './layoutInspector';

/**
 * Renders the fixtures and pins their page counts, so a pagination regression —
 * a block that suddenly refuses to share a page, or leading that silently
 * doubles — shows up as a diff rather than as a differently shaped email.
 *
 * Set `PDF_SNAPSHOT_DIR` to also drop the PDFs somewhere for a visual check:
 *
 *   PDF_SNAPSHOT_DIR=/tmp/pdf pnpm vitest run src/lib/pdf/render.test.ts
 */
const SNAPSHOT_DIR = process.env.PDF_SNAPSHOT_DIR;

const CASES: Array<[string, typeof gotoDocument, number]> = [
  ['goto', gotoDocument, 2],
  ['kitchen', kitchenSinkDocument, 6],
];

describe('fixture rendering', () => {
  for (const [name, doc, expectedPages] of CASES) {
    it(`renders ${name} to ${expectedPages} pages`, async () => {
      const buffer = await generateResearchSummaryPdf(doc);
      expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pageCount(buffer)).toBe(expectedPages);

      if (SNAPSHOT_DIR) {
        const fs = await import('node:fs');
        fs.writeFileSync(`${SNAPSHOT_DIR}/${name}.pdf`, buffer);
      }
    }, 60000);
  }
});
