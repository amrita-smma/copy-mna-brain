/**
 * Writes `PptxElement[]` slides into a .pptx buffer.
 *
 * Deliberately depends on pptxgenjs and nothing else — no Playwright, no
 * headless browser — so any producer that already knows its own geometry can
 * reach PowerPoint in environments where no browser binary exists (Vercel
 * functions, containers).
 */
import PptxGenJS from 'pptxgenjs';
import type {
  PptxElement,
  PptxSlide,
  PptxTableCell,
  PptxTextRun,
} from './pptxElements';

/** Draw one slide's elements onto a pptxgenjs slide, in painter order. */
export function applyElementsToSlide(
  slide: ReturnType<PptxGenJS['addSlide']>,
  elements: PptxElement[],
) {
  for (const el of elements) {
    if (el.w <= 0 || el.h <= 0) continue;

    switch (el.type) {
      case 'rect':
        slide.addShape('rect' as PptxGenJS.SHAPE_NAME, {
          x: el.x, y: el.y, w: el.w, h: el.h,
          fill: { color: el.fill },
          line: { color: el.fill, width: 0 },
        });
        break;

      case 'text': {
        if (!el.text.trim()) continue;
        // inset is [top, right, bottom, left] in inches — maps to PptxGenJS margin
        const margin = el.inset ?? [0.05, 0.05, 0.05, 0.05];
        // Mixed-formatting lines carry per-run options (bold lead-in labels,
        // italic asides); uniform ones fall back to the plain string.
        const content: string | PptxGenJS.TextProps[] =
          el.runs && el.runs.length > 0
            ? el.runs.map((run: PptxTextRun) => ({
                text: run.text,
                options: {
                  bold: run.bold,
                  italic: run.italic,
                  color: run.color ?? el.color ?? '000000',
                },
              }))
            : el.text;
        slide.addText(content, {
          x: el.x, y: el.y, w: el.w, h: el.h,
          fill: el.fill ? { color: el.fill } : { type: 'none' },
          margin,
          color: el.color ?? '000000',
          fontSize: el.fontSize ?? 9,
          bold: el.bold,
          italic: el.italic,
          align: (el.align as PptxGenJS.HAlign) ?? 'left',
          valign: (el.valign as PptxGenJS.VAlign) ?? 'top',
          wrap: true,
          autoFit: false,
        });
        break;
      }

      case 'table': {
        if (el.rows.length === 0) continue;
        const tableRows = el.rows.map(row =>
          row.map((cell: PptxTableCell) => ({
            text: cell.text,
            options: {
              bold: cell.bold,
              italic: cell.italic,
              color: cell.color ?? '000000',
              fill: cell.fill ? { color: cell.fill } : undefined,
              fontSize: cell.fontSize ?? 9,
              align: (cell.align as PptxGenJS.HAlign) ?? 'left',
              valign: 'middle' as const,
              colspan: cell.colspan && cell.colspan > 1 ? cell.colspan : undefined,
              rowspan: cell.rowspan && cell.rowspan > 1 ? cell.rowspan : undefined,
            },
          }))
        );
        slide.addTable(tableRows, {
          x: el.x, y: el.y, w: el.w, h: el.h,
          border: { pt: 0.5, color: 'E2E8F0' },
        });
        break;
      }
    }
  }
}

/** Render pre-laid-out slides into a .pptx buffer. */
export async function exportElementsToPptx(slides: PptxSlide[]): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';

  for (const slide of slides) {
    applyElementsToSlide(pptx.addSlide(), slide.elements);
  }

  const result = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.from(result as Uint8Array);
}
