import PptxGenJS from 'pptxgenjs';
import { htmlToPptxElementsBatch, type PptxElement, type PptxTableCell } from './htmlToPptxElements';

export interface SlideInput {
  title: string;
  html: string;
}

function applyElementsToSlide(slide: ReturnType<PptxGenJS['addSlide']>, elements: PptxElement[]) {
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
        slide.addText(el.text, {
          x: el.x, y: el.y, w: el.w, h: el.h,
          fill: el.fill ? { color: el.fill } : { type: 'none' },
          margin,
          color: el.color ?? '000000',
          fontSize: el.fontSize ?? 9,
          bold: el.bold,
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

export async function exportSlidesToPptx(slides: SlideInput[]): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';

  if (slides.length > 0) {
    const allElements = await htmlToPptxElementsBatch(slides.map(s => s.html));
    for (let i = 0; i < slides.length; i++) {
      const pptxSlide = pptx.addSlide();
      applyElementsToSlide(pptxSlide, allElements[i]);
    }
  }

  const result = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.from(result as Uint8Array);
}
