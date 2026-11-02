/**
 * The Pipeline "Present" deck as a .pptx (server-only — a template master
 * reads its logo off disk).
 *
 * The slide chrome follows the workspace's PowerPoint Template setting: with
 * StarCapital every slide sits on its master (logo, confidentiality line, page
 * tab and number); with Default (`template` null) the slides are plain white
 * with a small page number — no logo or branding of any kind.
 *
 * Either way the content is the StarCapital "1_Content 1 Section" layout: title, subtitle,
 * the three-dot marker, a section title, and one table in the template's table
 * syntax (its "Sample table" slide) — a navy #1A3F65 header row in bold white
 * Arial, unfilled body rows in Arial with a light-grey #D0CECE rule under
 * each, and no vertical borders. The columns are whichever the deck carries
 * (the table's open columns). Cells wrap rather than clip, so a row shows its
 * full content; rows are paginated by their estimated height (`paginateByHeight`)
 * so the table never runs into the footer. A table of more than
 * `WIDE_TABLE_COLUMNS` columns steps the type down one point, and a single row
 * too tall for one slide steps the body type down further (to
 * `MIN_BODY_FONT_SIZE`) rather than being cut.
 */
import PptxGenJS from 'pptxgenjs';
import { templateAssetDataUri, type PptxTemplate } from '@/lib/pptx/templates';
import type { PipelinePresentation } from '@/lib/pipeline/presentation';

const masterName = (template: PptxTemplate) => `${template.id.toUpperCase()}_CONTENT`;

/**
 * Register the template's master: background, logo and other fixed objects,
 * and the page number, as a pptxgenjs slide master.
 */
function defineTemplateMaster(pptx: PptxGenJS, template: PptxTemplate): void {
  const { master } = template;
  pptx.defineSlideMaster({
    title: masterName(template),
    background: { color: master.background },
    objects: master.objects.map((obj) =>
      obj.kind === 'image'
        ? {
            image: {
              x: obj.x, y: obj.y, w: obj.w, h: obj.h,
              data: templateAssetDataUri(obj.file),
            },
          }
        : {
            text: {
              text: obj.text,
              options: {
                x: obj.x, y: obj.y, w: obj.w, h: obj.h,
                fontFace: obj.fontFace,
                fontSize: obj.fontSize,
                color: obj.color,
                bold: obj.bold,
                align: obj.align,
                valign: 'middle',
                margin: 0,
              },
            },
          },
    ),
    slideNumber: {
      ...master.slideNumber,
      align: 'right',
      valign: 'middle',
    },
  });
}

/** A new slide on the template's master, or a plain one without a template. */
function addTemplateSlide(pptx: PptxGenJS, template: PptxTemplate | null) {
  return template ? pptx.addSlide({ masterName: masterName(template) }) : pptx.addSlide();
}

/** Geometry and type, in inches and points, from the template's layout. */
export const PRESENTATION_LAYOUT = {
  left: 0.28,
  width: 12.77,
  title: { y: 0.15, w: 11.11, h: 0.44, fontSize: 22, color: '0A2440' },
  subtitle: { y: 0.6, w: 11.11, h: 0.43, fontSize: 14, color: '212121' },
  dots: { xs: [0.43, 0.66, 0.9], y: 1.02, w: 0.09, h: 0.08, color: '054068' },
  section: { y: 1.4, h: 0.43, fontSize: 14, color: '0A2440' },
  table: {
    y: 1.96,
    headerH: 0.47,
    rowH: 0.36,
    headerFill: '1A3F65',
    headerColor: 'FFFFFF',
    headerFontSize: 11,
    bodyColor: '212121',
    bodyFontSize: 10,
    rule: 'D0CECE',
  },
} as const;

const FONT = 'Arial';
/** Lowest the body type goes to fit one very tall row on a slide. */
export const MIN_BODY_FONT_SIZE = 7;
/** The slide's usable bottom edge, in inches: above the footer and page number. */
const TABLE_BOTTOM = 6.9;
/** Arial's line pitch as a multiple of the font size. */
const LINE_HEIGHT = 1.2;
/** Widths are estimated, so over-estimate a little rather than clip a line. */
const WIDTH_SAFETY = 1.06;
/** The page number on an untemplated (Default) slide: small and grey, bottom right. */
const PLAIN_SLIDE_NUMBER = {
  x: 12.3, y: 7.0, w: 0.75, h: 0.3,
  fontFace: 'Arial', fontSize: 8, color: '6D7989', align: 'right' as const,
};
/** Past this many columns the table is set a point smaller (9pt body, 10pt header). */
export const WIDE_TABLE_COLUMNS = 10;
/** Cell margin [top, right, bottom, left] in inches (the template's 0.1" sides). */
const CELL_MARGIN: [number, number, number, number] = [0.03, 0.1, 0.03, 0.1];
const NO_BORDER = { type: 'none' as const };
const RULE = { type: 'solid' as const, pt: 0.75, color: PRESENTATION_LAYOUT.table.rule };

/**
 * Arial advance widths in em, by character class: narrow (i, l, punctuation),
 * space, lowercase, then digits and capitals. Close enough to keep a cell on
 * one line without clipping text that would have fit.
 */
function charEm(ch: string): number {
  if (/[ilj.,:;'!|]/.test(ch)) return 0.25;
  if (ch === ' ') return 0.28;
  if (/[a-z]/.test(ch)) return 0.52;
  if (/[MW@%]/.test(ch)) return 0.85;
  return 0.64;
}

/** Width in points of `text` set in Arial at `fontSize`. */
function textWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) width += charEm(ch) * fontSize;
  return width * WIDTH_SAFETY;
}

/**
 * How many lines `text` takes wrapped in a column `widthIn` wide: words wrap
 * at spaces, a word wider than the column breaks mid-word, and an explicit
 * newline starts a new line. At least one.
 */
export function wrappedLineCount(text: string, widthIn: number, fontSize: number): number {
  const usable = Math.max(1, widthIn - CELL_MARGIN[1] - CELL_MARGIN[3]) * 72;
  const space = textWidth(' ', fontSize);
  let lines = 0;
  for (const paragraph of text.split('\n')) {
    let used = 0;
    let count = 1;
    for (const word of paragraph.split(' ').filter(Boolean)) {
      let wordWidth = textWidth(word, fontSize);
      if (used > 0 && used + space + wordWidth <= usable) {
        used += space + wordWidth;
        continue;
      }
      if (used > 0) count += 1;
      // A word wider than the column fills whole lines, the rest starts the next.
      while (wordWidth > usable) {
        count += 1;
        wordWidth -= usable;
      }
      used = wordWidth;
    }
    lines += count;
  }
  return lines;
}

/** A row's height in inches: its tallest wrapped cell, never under `minH`. */
export function rowHeight(
  cells: readonly string[],
  colW: readonly number[],
  fontSize: number,
  minH: number,
): number {
  const lines = Math.max(1, ...cells.map((cell, i) => wrappedLineCount(cell, colW[i], fontSize)));
  const needed = (lines * fontSize * LINE_HEIGHT) / 72 + CELL_MARGIN[0] + CELL_MARGIN[2];
  return Math.max(minH, Math.round(needed * 100) / 100);
}

/** Cut rows into slides: as many as fit in `budget` inches of table body. */
export function paginateByHeight(
  rows: readonly string[][],
  heights: readonly number[],
  budget: number,
): { rows: string[][]; heights: number[] }[] {
  const pages: { rows: string[][]; heights: number[] }[] = [];
  let page: { rows: string[][]; heights: number[] } = { rows: [], heights: [] };
  let used = 0;
  rows.forEach((row, i) => {
    // A row taller than the whole budget still gets a slide to itself.
    if (page.rows.length > 0 && used + heights[i] > budget) {
      pages.push(page);
      page = { rows: [], heights: [] };
      used = 0;
    }
    page.rows.push([...row]);
    page.heights.push(heights[i]);
    used += heights[i];
  });
  if (page.rows.length > 0 || pages.length === 0) pages.push(page);
  return pages;
}

/** `offset` is how many rows the earlier slides hold; pages differ in length. */
function sectionTitle(
  page: number,
  pageCount: number,
  offset: number,
  count: number,
  total: number,
): string {
  if (total === 0) return 'Companies';
  const first = offset + 1;
  const last = offset + count;
  const range = `Companies ${first}–${last} of ${total}`;
  return pageCount > 1 ? `${range} (${page + 1}/${pageCount})` : range;
}

export function buildPipelinePresentationPptx(
  deck: PipelinePresentation,
  template: PptxTemplate | null,
): PptxGenJS {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = deck.title;
  if (template) defineTemplateMaster(pptx, template);

  const L = PRESENTATION_LAYOUT;
  const T = L.table;
  const columns = deck.columns;
  const colW = columns.map((c) => c.width);
  const wide = columns.length > WIDE_TABLE_COLUMNS;
  const headerFontSize = wide ? T.headerFontSize - 1 : T.headerFontSize;
  const baseBodyFontSize = wide ? T.bodyFontSize - 1 : T.bodyFontSize;
  // A header label may wrap onto more lines, so its row grows with it.
  const headerRowH = rowHeight(columns.map((c) => c.label), colW, headerFontSize, T.headerH);
  const budget = TABLE_BOTTOM - T.y - headerRowH;
  // Step the type down until the tallest row fits a slide on its own.
  let bodyFontSize = baseBodyFontSize;
  let heights = deck.rows.map((r) => rowHeight(r, colW, bodyFontSize, T.rowH));
  while (bodyFontSize > MIN_BODY_FONT_SIZE && Math.max(0, ...heights) > budget) {
    bodyFontSize -= 1;
    heights = deck.rows.map((r) => rowHeight(r, colW, bodyFontSize, T.rowH));
  }
  const pages = paginateByHeight(deck.rows, heights, budget);

  pages.forEach(({ rows, heights: pageHeights }, page) => {
    const slide = addTemplateSlide(pptx, template);
    // A template master draws its own page number; a plain slide gets one here.
    if (!template) slide.slideNumber = { ...PLAIN_SLIDE_NUMBER };
    const text = (
      value: string,
      box: { y: number; w: number; h: number },
      opts: { fontSize: number; color: string; bold?: boolean },
    ) =>
      slide.addText(value, {
        x: L.left, ...box, ...opts,
        fontFace: FONT, valign: 'middle', margin: 0, fit: 'none', wrap: false,
      });

    text(deck.title, L.title, { fontSize: L.title.fontSize, color: L.title.color });
    if (deck.subtitle) text(deck.subtitle, L.subtitle, { fontSize: L.subtitle.fontSize, color: L.subtitle.color });
    for (const x of L.dots.xs) {
      slide.addShape('ellipse', {
        x, y: L.dots.y, w: L.dots.w, h: L.dots.h,
        fill: { color: L.dots.color }, line: { color: L.dots.color, width: 0 },
      });
    }
    text(
      sectionTitle(
        page,
        pages.length,
        pages.slice(0, page).reduce((n, p) => n + p.rows.length, 0),
        rows.length,
        deck.rows.length,
      ),
      { y: L.section.y, w: L.width, h: L.section.h },
      { fontSize: L.section.fontSize, color: L.section.color, bold: true },
    );

    const header = columns.map((c) => ({
      text: c.label,
      options: {
        bold: true,
        color: T.headerColor,
        fill: { color: T.headerFill },
        fontFace: FONT,
        fontSize: headerFontSize,
        align: c.align,
        valign: 'middle' as const,
        margin: CELL_MARGIN,
        border: [NO_BORDER, NO_BORDER, NO_BORDER, NO_BORDER],
      },
    }));
    const body = rows.length
      ? rows.map((row) =>
          row.map((cell, i) => ({
            text: cell,
            options: {
              color: T.bodyColor,
              fontFace: FONT,
              fontSize: bodyFontSize,
              align: columns[i].align,
              valign: 'middle' as const,
              margin: CELL_MARGIN,
              border: [NO_BORDER, NO_BORDER, RULE, NO_BORDER],
            },
          })),
        )
      : [[{
          text: 'No companies match the current view.',
          options: {
            colspan: columns.length,
            color: T.bodyColor,
            fontFace: FONT,
            fontSize: bodyFontSize,
            align: 'center' as const,
            valign: 'middle' as const,
            margin: CELL_MARGIN,
            border: [NO_BORDER, NO_BORDER, RULE, NO_BORDER],
          },
        }]];

    slide.addTable([header, ...body] as PptxGenJS.TableRow[], {
      x: L.left,
      y: T.y,
      w: L.width,
      colW,
      rowH: [headerRowH, ...(rows.length ? pageHeights : [T.rowH])],
    });
  });

  return pptx;
}

/** The deck as .pptx bytes. */
export async function pipelinePresentationToPptx(
  deck: PipelinePresentation,
  template: PptxTemplate | null,
): Promise<Buffer> {
  const out = await buildPipelinePresentationPptx(deck, template).write({ outputType: 'nodebuffer' });
  return out as Buffer;
}

/** A safe download name, e.g. "pipeline-companies-2026-10-28.pptx". */
export function presentationFileName(deck: PipelinePresentation, now: Date = new Date()): string {
  const slug = deck.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pipeline';
  return `${slug}-${now.toISOString().slice(0, 10)}.pptx`;
}
