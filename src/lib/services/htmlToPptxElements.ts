import { chromium, type Browser, type Page } from '@playwright/test';

// PPTX LAYOUT_WIDE: 13.33" × 7.5" — same 16:9 ratio as the 1120×630 HTML slide
const SLIDE_W_IN = 13.33;
const SLIDE_W_PX = 1120;
const SLIDE_H_PX = 630;

// ── Public types ───────────────────────────────────────────────────────────
//
// The element IR is shared with the browser-free producer/writer in
// `@/lib/pptx/*`; re-exported here so existing importers keep working.

export type {
  PptxRect,
  PptxText,
  PptxTextRun,
  PptxTableCell,
  PptxTable,
  PptxElement,
} from '@/lib/pptx/pptxElements';

import type { PptxElement } from '@/lib/pptx/pptxElements';

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

  // Collect inline formatting runs for a leaf element. Descends through inline
  // children (<strong>, <em>, <span>, …) carrying bold/italic/color down, so a
  // "Label: value" line keeps its bold lead-in. Returns null when the leaf is
  // uniformly formatted — callers then fall back to the plain `text` path.
  function inlineRuns(
    el: Element,
    baseBold: boolean,
    baseItalic: boolean,
    baseColor: string | null,
  ): unknown[] | null {
    const runs: { text: string; bold: boolean; italic: boolean; color: string | null }[] = [];

    function push(text: string, bold: boolean, italic: boolean, color: string | null) {
      if (!text) return;
      const last = runs[runs.length - 1];
      if (last && last.bold === bold && last.italic === italic && last.color === color) {
        last.text += text;
      } else {
        runs.push({ text, bold, italic, color });
      }
    }

    function walkInline(node: Node, bold: boolean, italic: boolean, color: string | null): void {
      if (node.nodeType === 3) {
        push((node.textContent ?? '').replace(/[ \t\r]+/g, ' '), bold, italic, color);
        return;
      }
      if (node.nodeType !== 1) return;
      const child = node as Element;
      if (child.tagName === 'BR') {
        push('\n', bold, italic, color);
        return;
      }
      const cs = window.getComputedStyle(child);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const b = parseInt(cs.fontWeight) >= 700;
      const i = cs.fontStyle === 'italic' || cs.fontStyle === 'oblique';
      const c = rgbToHex(cs.color) ?? color;
      for (const n of child.childNodes) walkInline(n, b, i, c);
    }

    for (const n of el.childNodes) walkInline(n, baseBold, baseItalic, baseColor);

    // Drop whitespace-only runs at the ends (never in the middle — those carry
    // the space between two differently-formatted words), then trim what is
    // left at the edges.
    while (runs.length > 0 && runs[0].text.trim().length === 0) runs.shift();
    while (runs.length > 0 && runs[runs.length - 1].text.trim().length === 0) runs.pop();
    if (runs.length > 0) {
      runs[0].text = runs[0].text.replace(/^[ \t]+/, '');
      runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/[ \t]+$/, '');
    }
    const kept = runs.filter((r) => r.text.length > 0);
    if (kept.length < 2) return null;
    // Uniform formatting → nothing gained over the plain-text path.
    const varies = kept.some(
      (r) => r.bold !== kept[0].bold || r.italic !== kept[0].italic || r.color !== kept[0].color,
    );
    return varies ? kept : null;
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

      const runs = text ? inlineRuns(el, bold, cs.fontStyle === 'italic', color) : null;

      if (text && bg) {
        // Background + text → single addText with fill covering the full element.
        // This eliminates the separate rect/text stack and reduces overlapping layers.
        out.push({
          type: 'text',
          x, y, w, h,
          text,
          runs,
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
          runs,
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
