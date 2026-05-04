import { chromium, type Browser, type Page } from '@playwright/test';

// PPTX LAYOUT_WIDE: 13.33" × 7.5" — same 16:9 ratio as the 1120×630 HTML slide
const SLIDE_W_IN = 13.33;
const SLIDE_W_PX = 1120;
const SLIDE_H_PX = 630;

// ── Public types ───────────────────────────────────────────────────────────

export interface PptxRect {
  type: 'rect';
  x: number; y: number; w: number; h: number; // inches
  fill: string;
}

export interface PptxText {
  type: 'text';
  x: number; y: number; w: number; h: number;
  text: string;
  fill?: string;         // background fill (hex) — set when background+text are merged
  inset?: [number, number, number, number]; // [top, right, bottom, left] in inches
  color?: string;
  fontSize?: number;     // pt
  bold?: boolean;
  align?: string;
  valign?: string;
  wrap: boolean;
}

export interface PptxTableCell {
  text: string;
  bold?: boolean;
  fill?: string;
  color?: string;
  fontSize?: number;
  align?: string;
  colspan?: number;
  rowspan?: number;
}

export interface PptxTable {
  type: 'table';
  x: number; y: number; w: number; h: number;
  rows: PptxTableCell[][];
}

export type PptxElement = PptxRect | PptxText | PptxTable;

// ── Browser extraction script ──────────────────────────────────────────────
//
// Runs inside headless Chrome via page.evaluate().
// Rules: self-contained (no closures), returns only serializable values.

function browserExtractor(): unknown[] {
  const SLIDE_W = 1120;
  const SLIDE_H = 630;
  const W_IN = 13.33;
  const SCALE = W_IN / SLIDE_W;
  // px → pt using slide-proportional scale (13.33" × 72pt/in ÷ 1120px ≈ 0.857)
  const PT_PER_PX = W_IN * 72 / SLIDE_W;

  function toIn(px: number) { return px * SCALE; }
  function toPt(px: number) { return Math.max(6, Math.round(px * PT_PER_PX)); }

  function rgbToHex(color: string): string | null {
    if (!color) return null;
    const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    if (m[4] !== undefined && parseFloat(m[4]) < 0.05) return null; // transparent
    return [m[1], m[2], m[3]]
      .map((n: string) => parseInt(n).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }

  function normalizeAlign(a: string) {
    return a === 'start' || a === '-webkit-auto' ? 'left' : a === 'end' ? 'right' : a;
  }

  const BLOCK_TAGS = new Set([
    'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER', 'NAV',
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL',
    'BLOCKQUOTE', 'PRE', 'TABLE', 'FIGURE', 'FIGCAPTION',
  ]);

  function hasBlockChild(el: Element): boolean {
    for (const c of el.children) if (BLOCK_TAGS.has(c.tagName)) return true;
    return false;
  }

  // Get the rendered bounding rect of the actual text content (not the element box).
  // Returns null if the element has no text or the range fails.
  function getTextContentRect(el: Element): DOMRect | null {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      return (r.width > 0 && r.height > 0) ? r : null;
    } catch {
      return null;
    }
  }

  function tableRows(tableEl: Element): unknown[][] {
    const rows: unknown[][] = [];
    for (const tr of tableEl.querySelectorAll('tr')) {
      const row: unknown[] = [];
      for (const cell of (tr as Element).querySelectorAll('td, th')) {
        const cs = window.getComputedStyle(cell);
        row.push({
          text: (cell as HTMLElement).innerText?.trim() ?? '',
          bold: parseInt(cs.fontWeight) >= 700 || cell.tagName === 'TH',
          fill: rgbToHex(cs.backgroundColor),
          color: rgbToHex(cs.color),
          fontSize: toPt(parseFloat(cs.fontSize)),
          align: normalizeAlign(cs.textAlign),
          colspan: parseInt(cell.getAttribute('colspan') ?? '1'),
          rowspan: parseInt(cell.getAttribute('rowspan') ?? '1'),
        });
      }
      if (row.length) rows.push(row);
    }
    return rows;
  }

  const out: unknown[] = [];

  function walk(el: Element, depth: number): void {
    if (depth > 40) return;
    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;

    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    if (rect.right <= 0 || rect.bottom <= 0) return;
    if (rect.left >= SLIDE_W || rect.top >= SLIDE_H) return;

    const x = toIn(rect.left);
    const y = toIn(rect.top);
    const w = toIn(Math.min(rect.width,  SLIDE_W - Math.max(rect.left, 0)));
    const h = toIn(Math.min(rect.height, SLIDE_H - Math.max(rect.top,  0)));
    if (w <= 0.01 || h <= 0.01) return;

    const bg = rgbToHex(cs.backgroundColor);
    const color = rgbToHex(cs.color);
    const fontSize = toPt(parseFloat(cs.fontSize));
    const bold = parseInt(cs.fontWeight) >= 700;
    const align = normalizeAlign(cs.textAlign);

    // ── Tables ──────────────────────────────────────────────────────────
    if (el.tagName === 'TABLE') {
      out.push({ type: 'table', x, y, w, h, rows: tableRows(el) });
      return;
    }

    // ── Leaf elements (no block children) ───────────────────────────────
    if (!hasBlockChild(el)) {
      const text = (el as HTMLElement).innerText?.trim();
      const pl = parseFloat(cs.paddingLeft)   || 0;
      const pt = parseFloat(cs.paddingTop)    || 0;
      const pr = parseFloat(cs.paddingRight)  || 0;
      const pb = parseFloat(cs.paddingBottom) || 0;

      if (text && bg) {
        // Background + text → single addText with fill covering the full element.
        // This eliminates the separate rect/text stack and reduces overlapping layers.
        out.push({
          type: 'text',
          x, y, w, h,
          text,
          fill: bg,
          inset: [toIn(pt), toIn(pr), toIn(pb), toIn(pl)],
          color,
          fontSize,
          bold,
          align,
          valign: 'top',
          wrap: true,
        });
      } else if (text) {
        // Text only → use the actual rendered text bounds to keep the box compact.
        // This prevents oversized transparent text boxes from blocking clicks on
        // elements below them in the PPTX.
        const textRect = getTextContentRect(el);
        const tx = textRect ? textRect.left        : rect.left + pl;
        const ty = textRect ? textRect.top         : rect.top  + pt;
        const tw = textRect ? Math.max(textRect.width,  rect.width  - pl - pr) : rect.width  - pl - pr;
        const th = textRect ? textRect.height + 2 : rect.height - pt - pb; // +2px buffer
        out.push({
          type: 'text',
          x: toIn(tx), y: toIn(ty),
          w: toIn(Math.max(tw, 5)), h: toIn(Math.max(th, 5)),
          text,
          fill: null,
          color,
          fontSize,
          bold,
          align,
          valign: 'top',
          wrap: true,
        });
      } else if (bg) {
        // Background only (no text) → plain rect
        out.push({ type: 'rect', x, y, w, h, fill: bg });
      }

      return; // leaf — do not recurse
    }

    // ── Container elements (have block children) ─────────────────────────
    // Emit background rect only — children handle their own content.
    if (bg) out.push({ type: 'rect', x, y, w, h, fill: bg });

    for (const child of el.children) walk(child, depth + 1);
  }

  const root = document.body.firstElementChild;
  if (root) walk(root, 0);
  return out;
}

// ── Page-level extraction ──────────────────────────────────────────────────

async function extractFromPage(page: Page, html: string): Promise<PptxElement[]> {
  await page.setContent(
    `<!DOCTYPE html><html><head>` +
    `<style>*{box-sizing:border-box}body{margin:0;padding:0;overflow:hidden}</style>` +
    `</head><body>${html}</body></html>`,
    { waitUntil: 'domcontentloaded' },
  );
  const raw = await page.evaluate(browserExtractor);
  return raw as PptxElement[];
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function htmlToPptxElementsBatch(htmls: string[]): Promise<PptxElement[][]> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setViewportSize({ width: SLIDE_W_PX, height: SLIDE_H_PX });

    const results: PptxElement[][] = [];
    for (const html of htmls) {
      results.push(await extractFromPage(page, html));
    }
    return results;
  } finally {
    await browser?.close();
  }
}

export async function htmlToPptxElements(html: string): Promise<PptxElement[]> {
  const [result] = await htmlToPptxElementsBatch([html]);
  return result;
}
