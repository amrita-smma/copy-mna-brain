/**
 * The shape-level intermediate representation a slide is built from: absolutely
 * positioned rectangles, text boxes, and tables, measured in inches on a
 * 13.33" × 7.5" (LAYOUT_WIDE) slide.
 *
 * Two producers feed it:
 *   - `@/lib/services/htmlToPptxElements` — extracts elements from rendered
 *     HTML via headless Chromium (used for AI-authored slide decks, whose
 *     markup is arbitrary and must genuinely be laid out by a browser).
 *   - `@/lib/pptx/companyCardSlides` — emits elements directly, because it
 *     computes its own geometry and so needs no browser at all.
 *
 * Both are consumed by `@/lib/pptx/writePptx`. Keeping the types here (rather
 * than in the extractor) is what lets the direct producer stay free of any
 * Playwright import — types are erased at compile time, so nothing pulls the
 * browser into a runtime that does not have one.
 */

export interface PptxRect {
  type: 'rect';
  x: number; y: number; w: number; h: number; // inches
  fill: string;                                // hex, no leading '#'
}

/**
 * One inline formatting run inside a text box. Emitted when a line mixes
 * formatting (e.g. a bullet with a bold lead-in label), so `**Label**: rest`
 * survives into PowerPoint as real bold rather than one flat weight.
 */
export interface PptxTextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  color?: string;
}

export interface PptxText {
  type: 'text';
  x: number; y: number; w: number; h: number;
  text: string;
  /** Rich-text runs; when present they take precedence over `text`. */
  runs?: PptxTextRun[];
  fill?: string;         // background fill (hex) — set when background+text are merged
  inset?: [number, number, number, number]; // [top, right, bottom, left] in inches
  color?: string;
  fontSize?: number;     // pt
  bold?: boolean;
  italic?: boolean;
  align?: string;
  valign?: string;
  wrap: boolean;
}

export interface PptxTableCell {
  text: string;
  bold?: boolean;
  italic?: boolean;
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

/** One finished slide: a title (for logging/filenames) and its shapes. */
export interface PptxSlide {
  title: string;
  elements: PptxElement[];
}

// ── Design-space → slide-space conversion ──────────────────────────────────
//
// Layout is authored in a 1120×630 px design space (the same viewport the HTML
// extractor renders into), which maps 1:1 onto the 13.33"×7.5" wide slide.

export const SLIDE_W_PX = 1120;
export const SLIDE_H_PX = 630;
export const SLIDE_W_IN = 13.33;

const PX_TO_IN = SLIDE_W_IN / SLIDE_W_PX;
const PX_TO_PT = (SLIDE_W_IN * 72) / SLIDE_W_PX;

/** Design-space px → inches. */
export const toIn = (px: number): number => px * PX_TO_IN;

/** Design-space px (CSS font-size) → PowerPoint points. */
export const toPt = (px: number): number => Math.max(6, Math.round(px * PX_TO_PT));
