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
 * (the table's open columns). Rows are paginated (`paginatePresentationRows`)
 * rather than shrunk; a table of more than `WIDE_TABLE_COLUMNS` columns steps
 * the type down one point, and never further.
 */
import PptxGenJS from 'pptxgenjs';
import { templateAssetDataUri, type PptxTemplate } from '@/lib/pptx/templates';
import {
  paginatePresentationRows,
  type PipelinePresentation,
} from '@/lib/pipeline/presentation';

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

/**
 * Fit a cell to one line of its column. A value too long for the column is
 * clipped and ends in "…", rather than wrapping into the next row's space.
 */
export function fitCellText(text: string, widthIn: number, fontSize: number): string {
  const usable = Math.max(0, widthIn - CELL_MARGIN[1] - CELL_MARGIN[3]) * 72;
  const ellipsis = fontSize;
  let used = 0;
  for (let i = 0; i < text.length; i++) {
    used += charEm(text[i]) * fontSize;
    if (used > usable) {
      // Back off until the ellipsis fits too.
      let end = i;
      let width = used - charEm(text[i]) * fontSize;
      while (end > 1 && width + ellipsis > usable) {
        end -= 1;
        width -= charEm(text[end]) * fontSize;
      }
      return `${text.slice(0, Math.max(1, end)).trimEnd()}…`;
    }
  }
  return text;
}

function sectionTitle(page: number, pageCount: number, perPage: number, total: number): string {
  if (total === 0) return 'Companies';
  const first = page * perPage + 1;
  const last = Math.min(total, first + perPage - 1);
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
  const bodyFontSize = wide ? T.bodyFontSize - 1 : T.bodyFontSize;
  const pages = paginatePresentationRows(deck.rows);
  const perPage = pages[0]?.length || 1;

  pages.forEach((rows, page) => {
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
      sectionTitle(page, pages.length, perPage, deck.rows.length),
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
            text: fitCellText(cell, colW[i], bodyFontSize),
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
      rowH: [T.headerH, ...body.map(() => T.rowH)],
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
