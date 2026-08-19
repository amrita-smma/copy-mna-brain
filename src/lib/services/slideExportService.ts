import PptxGenJS from 'pptxgenjs';
import { htmlToPptxElementsBatch } from './htmlToPptxElements';
import { applyElementsToSlide } from '@/lib/pptx/writePptx';

export interface SlideInput {
  title: string;
  html: string;
}

/**
 * Render HTML slides to a .pptx.
 *
 * NOTE: this path lays the HTML out in headless Chromium, so it needs a
 * Playwright browser binary at runtime. It is the right tool for AI-authored
 * slide decks, whose markup is arbitrary. Producers that compute their own
 * geometry (e.g. the Company Card) should emit `PptxElement[]` and use
 * `@/lib/pptx/writePptx → exportElementsToPptx`, which needs no browser.
 */
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
