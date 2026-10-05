/**
 * Renders the "L0 → L1 Submission" Company Card (the Overview tab of
 * `CompanyDetailDialog` / `CompanyOverviewSlide`) straight into PowerPoint
 * shapes (`PptxElement[]`) that `@/lib/pptx/writePptx` turns into a .pptx.
 *
 * Three properties drive every decision here:
 *
 * 1. **Same format** — the layout mirrors the on-screen card: blue rule +
 *    numbered section badges, the meta/deal-status box grids, the three-column
 *    body (Target Overview + Financials + Deal Structure | Investment Thesis |
 *    Diligence + Kill criteria), and the confidentiality footer.
 * 2. **Super condensed and non-overlapping** — a slide is a fixed 630px box, so
 *    content cannot be allowed to run past it. Every block's rendered height is
 *    estimated up front and packed into fixed-height column budgets; whatever
 *    does not fit flows onto "(cont.)" slides instead of overprinting.
 * 3. **No browser** — because this module computes all its own geometry, it
 *    emits shapes directly instead of round-tripping through headless Chromium
 *    like the AI slide-deck export does. That keeps the Company Card working in
 *    runtimes with no Playwright browser binary (Vercel functions, containers),
 *    and skips a ~1–3s browser launch per deck.
 *
 * Layout is authored in the same 1120×630 px design space the HTML extractor
 * uses, converted to inches only at emission time.
 */

import { companyDisplayTitle } from '@/lib/companyDisplay';
import { CURRENCY_SYMBOL, type Currency } from '@/lib/currency';
import { isDealLive } from '@/lib/dealStatus';
import { dealLeadLabel } from '@/lib/tracks/matchTracks';
import {
  SLIDE_W_PX,
  SLIDE_H_PX,
  toIn,
  toPt,
  type PptxElement,
  type PptxSlide,
  type PptxTableCell,
  type PptxText,
  type PptxTextRun,
} from './pptxElements';

// ── Slide geometry (design-space px) ───────────────────────────────────────

const SLIDE_W = SLIDE_W_PX;
const SLIDE_H = SLIDE_H_PX;
const PAD = 16;
const COL_GAP = 14;
const COL_COUNT = 3;
export const COL_W = Math.floor((SLIDE_W - PAD * 2 - COL_GAP * (COL_COUNT - 1)) / COL_COUNT);

/** Header (title + stage track) block on the first slide of a company. */
const HEADER_H = 54;
/** Two rows of four meta/deal-status boxes (each box holds up to two lines). */
const META_BOX_H = 28;
const META_H = META_BOX_H * 2 + 11;
/** Slim title bar on "(cont.)" slides. */
const CONT_HEADER_H = 30;
/** "Strictly Private and Confidential" strip. */
const FOOTER_H = 16;

/** Usable column height on the first slide of a company. */
export const BODY_H = SLIDE_H - PAD * 2 - HEADER_H - META_H - FOOTER_H;
/** Usable column height on a continuation slide. */
export const CONT_BODY_H = SLIDE_H - PAD * 2 - CONT_HEADER_H - FOOTER_H;

/** Slack left unpacked so a line that wraps one row wider than estimated still
 *  lands inside the slide rather than colliding with the footer. */
const SAFETY = 10;
const BODY_BUDGET = BODY_H - SAFETY;
const CONT_BODY_BUDGET = CONT_BODY_H - SAFETY;

/** Top of the body columns on each slide kind. */
const BODY_TOP = PAD + HEADER_H + META_H;
const CONT_BODY_TOP = PAD + CONT_HEADER_H;

// ── Palette (hex without '#', as pptxgenjs expects) ────────────────────────

const NAVY = '1E3A8A';
const BLUE = '1E40AF';
const RULE = '93C5FD';
const RED = 'DC2626';
const RED_RULE = 'FCA5A5';
const INK = '111827';
const MUTED = '6B7280';
const BOX_BG = 'F1F5F9';
const LIVE_BG = 'ECFDF5';
const LIVE_INK = '047857';
const CHIP_BG = 'EEF2F7';
const CHIP_INK = '64748B';
const TABLE_HEAD_BG = 'EFF6FF';
const HAIRLINE = 'E2E8F0';
const FOOTER_INK = '94A3B8';
const WHITE = 'FFFFFF';

// ── Text metrics used to estimate wrapped height ───────────────────────────

const BODY_FONT = 9;
const LINE_H = 12;
/** Average advance width of one character at 9px Arial — deliberately slightly
 *  pessimistic so estimates over-reserve rather than overflow. */
const CHAR_W = 4.75;

const SECTION_HEADING_H = 22;
const SUBHEADING_H = 16;

function linesFor(text: string, width: number): number {
  const perLine = Math.max(8, Math.floor(width / CHAR_W));
  const hardLines = text.split('\n');
  return hardLines.reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)),
    0,
  );
}

// ── Inline markdown → formatting runs ──────────────────────────────────────

export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

/**
 * Split inline markdown into formatting runs. Only the subset the AI Company
 * Card emits is handled: `**bold**`, `*italic*`, and `` `code` `` (rendered as
 * plain text). Everything else is literal.
 */
export function parseInline(raw: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const pattern = /\*\*([^*]+)\*\*|\*([^*\n]+)\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;

  const push = (text: string, style?: { bold?: boolean; italic?: boolean }) => {
    if (!text) return;
    const prev = runs[runs.length - 1];
    const bold = style?.bold;
    const italic = style?.italic;
    if (prev && prev.bold === bold && prev.italic === italic) prev.text += text;
    else runs.push({ text, bold, italic });
  };

  while ((m = pattern.exec(raw)) !== null) {
    push(raw.slice(last, m.index));
    if (m[1] !== undefined) push(m[1], { bold: true });
    else if (m[2] !== undefined) push(m[2], { italic: true });
    else push(m[3] ?? '');
    last = pattern.lastIndex;
  }
  push(raw.slice(last));

  return runs.filter((r) => r.text.length > 0);
}

/** Flatten runs back to plain text (used for height estimation). */
export const runsText = (runs: InlineRun[]): string => runs.map((r) => r.text).join('');

// ── Markdown (the AI Company Card narrative) → renderable blocks ───────────

export type CardBlockKind = 'subheading' | 'bullet' | 'numbered' | 'paragraph';

export interface CardBlock {
  kind: CardBlockKind;
  /** Plain text, used for height estimation. */
  text: string;
  /** Inline formatting runs. */
  runs: InlineRun[];
  /** List marker for numbered items ("1."). */
  marker?: string;
}

function block(kind: CardBlockKind, raw: string, marker?: string): CardBlock {
  const runs = parseInline(raw);
  return { kind, text: runsText(runs), runs, marker };
}

/**
 * Parse the narrative markdown into flat blocks. Only the constructs the AI
 * Company Card actually produces are handled: headings, `-`/`*` bullets,
 * `1.` numbered items, and paragraphs. Wrapped continuation lines are folded
 * back into the item they belong to.
 */
export function parseCardMarkdown(markdown: string | null | undefined): CardBlock[] {
  if (!markdown || !markdown.trim()) return [];
  const blocks: CardBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join(' ').trim();
    paragraph = [];
    if (text) blocks.push(block('paragraph', text));
  };

  for (const rawLine of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) {
      flushParagraph();
      blocks.push(block('subheading', heading[1].trim()));
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      blocks.push(block('bullet', bullet[1].trim()));
      continue;
    }

    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      flushParagraph();
      blocks.push(block('numbered', numbered[2].trim(), `${numbered[1]}.`));
      continue;
    }

    // An indented line under a list item is that item's wrapped tail. Only list
    // items absorb it — folding it into a heading would corrupt the heading.
    const last = blocks[blocks.length - 1];
    if (
      /^\s{2,}/.test(rawLine) &&
      paragraph.length === 0 &&
      last &&
      (last.kind === 'bullet' || last.kind === 'numbered')
    ) {
      const tail = line.trim();
      last.runs = [...last.runs, { text: ' ' }, ...parseInline(tail)];
      last.text = runsText(last.runs);
      continue;
    }

    paragraph.push(line.trim());
  }
  flushParagraph();
  return blocks;
}

// ── Renderable, pre-measured pieces ────────────────────────────────────────

/**
 * A measured block of card content. `h` is its estimated height in design-space
 * px; `render` draws it at an absolute position once pagination has decided
 * where it lands.
 */
export interface Piece {
  /** Estimated rendered height in px, including its bottom margin. */
  h: number;
  /** Emit shapes for this piece at (x, y) within a column `w` px wide. */
  render: (x: number, y: number, w: number) => PptxElement[];
}

const BULLET_INDENT = 9;
const NUMBER_INDENT = 15;

interface TextOpts {
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  align?: string;
  fill?: string;
  valign?: string;
}

/** A text box carrying inline runs, positioned and sized in design-space px. */
function textEl(
  runs: InlineRun[],
  x: number,
  y: number,
  w: number,
  h: number,
  opts: TextOpts = {},
): PptxElement {
  const color = opts.color ?? INK;
  const pptxRuns: PptxTextRun[] = runs.map((r) => ({
    text: r.text,
    bold: r.bold || opts.bold,
    italic: r.italic || opts.italic,
    color,
  }));
  return {
    type: 'text',
    x: toIn(x), y: toIn(y), w: toIn(w), h: toIn(h),
    text: runsText(runs),
    // A single uniform run gains nothing over the plain-text path.
    runs: pptxRuns.length > 1 ? pptxRuns : undefined,
    fill: opts.fill,
    inset: [0, 0, 0, 0],
    color,
    fontSize: toPt(opts.fontSize ?? BODY_FONT),
    bold: opts.bold,
    italic: opts.italic,
    align: opts.align ?? 'left',
    valign: opts.valign ?? 'top',
    wrap: true,
  };
}

const plainText = (
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: TextOpts = {},
): PptxElement => textEl([{ text }], x, y, w, h, opts);

const rect = (x: number, y: number, w: number, h: number, fill: string): PptxElement => ({
  type: 'rect',
  x: toIn(x), y: toIn(y), w: toIn(w), h: toIn(h),
  fill,
});

/** Render one parsed block into a measured piece for the given column width. */
export function renderBlock(cardBlock: CardBlock, width: number): Piece {
  switch (cardBlock.kind) {
    case 'subheading':
      return {
        h: SUBHEADING_H,
        render: (x, y, w) => [
          textEl(cardBlock.runs, x, y + 4, w, LINE_H, {
            fontSize: 9.5,
            bold: true,
            color: NAVY,
          }),
        ],
      };
    case 'bullet': {
      const lines = linesFor(cardBlock.text, width - BULLET_INDENT);
      return {
        h: lines * LINE_H + 3,
        // Marker and body are separate boxes so the body keeps a true hanging
        // indent — they never overlap because they do not share x-range.
        render: (x, y, w) => [
          plainText('•', x, y, BULLET_INDENT, LINE_H),
          textEl(cardBlock.runs, x + BULLET_INDENT, y, w - BULLET_INDENT, lines * LINE_H),
        ],
      };
    }
    case 'numbered': {
      const marker = cardBlock.marker ?? '';
      const lines = linesFor(cardBlock.text, width - NUMBER_INDENT);
      return {
        h: lines * LINE_H + 3,
        render: (x, y, w) => [
          plainText(marker, x, y, NUMBER_INDENT, LINE_H),
          textEl(cardBlock.runs, x + NUMBER_INDENT, y, w - NUMBER_INDENT, lines * LINE_H),
        ],
      };
    }
    case 'paragraph':
    default: {
      const lines = linesFor(cardBlock.text, width);
      return {
        h: lines * LINE_H + 4,
        render: (x, y, w) => [textEl(cardBlock.runs, x, y, w, lines * LINE_H)],
      };
    }
  }
}

function narrativePieces(
  markdown: string | null | undefined,
  width: number,
  placeholder: string,
): Piece[] {
  const blocks = parseCardMarkdown(markdown);
  if (blocks.length === 0) {
    const lines = linesFor(placeholder, width);
    return [
      {
        h: lines * LINE_H + 4,
        render: (x, y, w) =>
          [plainText(placeholder, x, y, w, lines * LINE_H, { italic: true, color: MUTED })],
      },
    ];
  }
  return blocks.map((b) => renderBlock(b, width));
}

// ── Static card chrome ─────────────────────────────────────────────────────

const DEFAULT_STAGES: ReadonlyArray<{ key: string; code: string }> = [
  'L0',
  'L1',
  'L2',
  'L3',
  'L4',
  'L5',
].map((key) => ({ key, code: key }));

/** Width the stage track may take: six 26pt chips, as the card was designed. */
const STAGE_TRACK_W = 6 * 27;

const BADGE = 13;

/**
 * Numbered section heading: badge + title + coloured rule. Kill criteria has no
 * numbered badge on the card — it is a red sub-label under section 5 — so a
 * continuation of it must not borrow badge 5.
 */
function sectionHeadingElements(
  index: number | null,
  title: string,
  x: number,
  y: number,
  w: number,
): PptxElement[] {
  const els: PptxElement[] = [];
  const titleX = index === null ? x : x + BADGE + 5;
  if (index !== null) {
    els.push(rect(x, y, BADGE, BADGE, BLUE));
    els.push(
      plainText(String(index), x, y + 1, BADGE, 11, {
        fontSize: 8.5,
        bold: true,
        color: WHITE,
        align: 'center',
      }),
    );
  }
  els.push(
    plainText(title, titleX, y, w - (titleX - x), 13, {
      fontSize: 10.5,
      bold: true,
      color: index === null ? RED : NAVY,
    }),
  );
  els.push(rect(x, y + 15, w, 2, index === null ? RED_RULE : RULE));
  return els;
}

function sectionHeadingPiece(index: number | null, title: string): Piece {
  return {
    h: SECTION_HEADING_H,
    render: (x, y, w) => sectionHeadingElements(index, title, x, y, w),
  };
}

/** One "Label: value" box from the two meta grids. */
function metaBox(
  label: string,
  value: string,
  x: number,
  y: number,
  w: number,
  tone: 'default' | 'live' = 'default',
): PptxElement[] {
  const labelColor = tone === 'live' ? LIVE_INK : NAVY;
  return [
    rect(x, y, w, META_BOX_H, tone === 'live' ? LIVE_BG : BOX_BG),
    textEl(
      [
        { text: `${label}: `, bold: true },
        { text: value },
      ],
      x + 6,
      y + 3,
      w - 12,
      META_BOX_H - 6,
      { fontSize: 8.5, color: labelColor },
    ),
  ];
}

/**
 * Meta boxes render their label in the accent colour and the value in ink, so
 * the two runs need different colours — `textEl` applies one colour to the whole
 * box, so the value run is re-coloured here.
 */
function metaBoxRow(
  cells: { label: string; value: string; tone?: 'default' | 'live' }[],
  y: number,
): PptxElement[] {
  const gap = 6;
  const w = Math.floor((SLIDE_W - PAD * 2 - gap * (cells.length - 1)) / cells.length);
  return cells.flatMap((cell, i) => {
    const els = metaBox(cell.label, cell.value, PAD + i * (w + gap), y, w, cell.tone);
    const text = els[1];
    if (text.type === 'text' && text.runs && text.runs.length > 1) {
      text.runs[1].color = INK;
    }
    return els;
  });
}

function headerElements(
  title: string,
  subtitle: string,
  currentStage: string,
  stages: ReadonlyArray<{ key: string; code: string }>,
): PptxElement[] {
  const els: PptxElement[] = [];
  const right = SLIDE_W - PAD;

  els.push(plainText(title, PAD, PAD, 700, 21, { fontSize: 17, bold: true, color: NAVY }));
  els.push(
    plainText(subtitle, PAD, PAD + 23, 700, 13, { fontSize: 9.5, italic: true, color: MUTED }),
  );

  // Stage track, laid out right-to-left from the "Seeking approval" caption.
  const CAPTION_W = 92;
  // Chips shrink to keep a workspace with more stages inside the designed width.
  const CHIP_W = Math.min(26, Math.floor(STAGE_TRACK_W / Math.max(stages.length, 1)) - 1);
  const CHIP_H = 17;
  const chipsRight = right - CAPTION_W - 6;
  const chipsLeft = chipsRight - stages.length * (CHIP_W + 1);
  els.push(
    plainText('→ Seeking approval', chipsRight + 6, PAD + 3, CAPTION_W, 12, {
      fontSize: 8.5,
      bold: true,
      color: BLUE,
    }),
  );
  stages.forEach((stage, i) => {
    const x = chipsLeft + i * (CHIP_W + 1);
    const active = stage.key === currentStage;
    els.push(rect(x, PAD, CHIP_W, CHIP_H, active ? BLUE : CHIP_BG));
    els.push(
      plainText(stage.code, x, PAD + 3, CHIP_W, 11, {
        fontSize: 8.5,
        bold: true,
        color: active ? WHITE : CHIP_INK,
        align: 'center',
      }),
    );
  });

  els.push(rect(PAD, PAD + HEADER_H - 6, SLIDE_W - PAD * 2, 2, BLUE));
  return els;
}

function footerElements(companyUrl?: string): PptxElement[] {
  const y = SLIDE_H - PAD - FOOTER_H;
  const els: PptxElement[] = [
    rect(PAD, y, SLIDE_W - PAD * 2, 1, HAIRLINE),
    plainText('STRICTLY PRIVATE AND CONFIDENTIAL', PAD, y + 4, 400, 10, {
      fontSize: 7.5,
      bold: true,
      color: FOOTER_INK,
    }),
  ];
  if (companyUrl) {
    const linkW = 200;
    els.push({
      ...(plainText('Open in Brain', SLIDE_W - PAD - linkW, y + 4, linkW, 10, {
        fontSize: 7.5,
        bold: true,
        color: BLUE,
        align: 'right',
      }) as PptxText),
      hyperlink: { url: companyUrl, tooltip: 'Open in Brain' },
    });
  }
  return els;
}

/** Lay a column's pieces out top-down from `top`, emitting their shapes. */
function renderColumn(pieces: Piece[], colIndex: number, top: number): PptxElement[] {
  const x = PAD + colIndex * (COL_W + COL_GAP);
  const els: PptxElement[] = [];
  let y = top;
  for (const piece of pieces) {
    els.push(...piece.render(x, y, COL_W));
    y += piece.h;
  }
  return els;
}

// ── Company inputs ─────────────────────────────────────────────────────────

export interface CardFinancialRow {
  fiscal_year: number;
  revenue_usd_mn: number | null;
  ebitda_usd_mn: number | null;
}

/** Structural fields of the card. Mirrors `OverviewSlideCompany`, so a
 *  `CompanyDTO` can be passed straight through. */
export interface CompanyCardCompany {
  target: string | null;
  project_name?: string | null;
  segment: string | null;
  geography: string | null;
  pipeline_stage: string | null;
  deal_type?: string | null;
  stake?: string | null;
  deal_size?: string | null;
  ev_2024: number | null;
  ownership: string | null;
  banker?: string | null;
  entered_by_name?: string | null;
  advisor?: string | null;
  is_live?: boolean | null;
  nbo_date?: string | null;
  source: string | null;
  revenue_2022_usd_mn?: number | null;
  revenue_2023_usd_mn?: number | null;
  revenue_2024_usd_mn?: number | null;
  ebitda_2022_usd_mn?: number | null;
  ebitda_2023_usd_mn?: number | null;
  ebitda_2024_usd_mn?: number | null;
  financials_raw?: CardFinancialRow[];
}

export interface CompanyCardAnalysis {
  business_overview?: string | null;
  business_model_summary?: string | null;
  investment_highlights?: string | null;
  investment_risks?: string | null;
  diligence_priorities?: string | null;
}

export interface CompanyCardTrackVariable {
  name: string;
  unit?: string | null;
  value: string;
}

export interface CompanyCardSlideInput {
  company: CompanyCardCompany;
  analysis: CompanyCardAnalysis | null;
  /** Workspace display currency — labels only, no FX conversion. */
  currency: Currency;
  /** Resolved Deal Sponsor / Deal Captain (per-company override or Track PIC). */
  dealLead?: string | null;
  /** Track variables the user surfaced under Indicative Financials. */
  trackVariables?: CompanyCardTrackVariable[];
  /** Absolute URL to the company's dedicated page in the app, e.g. `${appUrl}/pipeline/${companyId}`. */
  companyUrl?: string;
  /**
   * The workspace's live stages in pipeline order, drawn as the header's stage
   * track (code per chip). Defaults to the six original stages.
   */
  stages?: ReadonlyArray<{ key: string; code: string }>;
  /** Stage keys from L3 onward in the workspace's order — where the lead is the Deal Captain. */
  captainStageKeys?: readonly string[];
}

/** One finished card slide. */
export type CompanyCardSlide = PptxSlide;

// ── Field formatting (mirrors CompanyOverviewSlide) ─────────────────────────

const fmtDate = (value: string | null | undefined): string => {
  if (!value) return '—';
  const [y, m, d] = value.split('T')[0].split('-').map(Number);
  if (!y || !m || !d) return value;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

const fmtMargin = (
  ebitda: number | null | undefined,
  revenue: number | null | undefined,
): string => {
  if (ebitda == null || revenue == null || revenue === 0) return '—';
  return `${((ebitda / revenue) * 100).toFixed(1)}%`;
};

function moneyFormatter(currency: Currency) {
  const sym = CURRENCY_SYMBOL[currency];
  return (value: number | null | undefined): string => {
    if (value == null) return '—';
    if (Math.abs(value) >= 1000) return `${sym}${(value / 1000).toFixed(2)}B`;
    return `${sym}${value.toFixed(1)}M`;
  };
}

function buildFinancials(company: CompanyCardCompany): {
  year: number;
  revenue: number | null;
  ebitda: number | null;
}[] {
  if (company.financials_raw && company.financials_raw.length > 0) {
    return [...company.financials_raw]
      .sort((a, b) => a.fiscal_year - b.fiscal_year)
      .slice(-3)
      .map((r) => ({ year: r.fiscal_year, revenue: r.revenue_usd_mn, ebitda: r.ebitda_usd_mn }));
  }
  return [2022, 2023, 2024]
    .map((y) => ({
      year: y,
      revenue: company[`revenue_${y}_usd_mn` as keyof CompanyCardCompany] as number | null,
      ebitda: company[`ebitda_${y}_usd_mn` as keyof CompanyCardCompany] as number | null,
    }))
    .filter((r) => r.revenue != null || r.ebitda != null);
}

// ── Fixed (never-paginated) column-1 blocks ────────────────────────────────

const TABLE_ROW_H = 15;

function financialsPiece(
  company: CompanyCardCompany,
  currency: Currency,
  trackVariables: CompanyCardTrackVariable[],
): Piece {
  const fmtMoney = moneyFormatter(currency);
  const rows = buildFinancials(company);
  const heading = sectionHeadingPiece(4, `Indicative Financials (${currency} m)`);

  if (rows.length === 0 && trackVariables.length === 0) {
    return {
      h: SECTION_HEADING_H + LINE_H + 4,
      render: (x, y, w) => [
        ...heading.render(x, y, w),
        plainText('No financial data available.', x, y + SECTION_HEADING_H, w, LINE_H, {
          italic: true,
          color: MUTED,
        }),
      ],
    };
  }

  const tableH = rows.length > 0 ? 4 * TABLE_ROW_H + 4 : 0;
  const varsH = trackVariables.length * 13;

  return {
    h: SECTION_HEADING_H + tableH + varsH + 6,
    render: (x, y, w) => {
      const els = [...heading.render(x, y, w)];
      let cursor = y + SECTION_HEADING_H;

      if (rows.length > 0) {
        const head: PptxTableCell[] = [
          { text: `${currency} m`, bold: true, fill: TABLE_HEAD_BG, color: NAVY, fontSize: toPt(8.5), align: 'left' },
          ...rows.map((r) => ({
            text: String(r.year),
            bold: true,
            fill: TABLE_HEAD_BG,
            color: NAVY,
            fontSize: toPt(8.5),
            align: 'right',
          })),
        ];
        const money = (label: string, pick: (r: (typeof rows)[number]) => string): PptxTableCell[] => [
          { text: label, bold: true, fontSize: toPt(8.5), align: 'left', color: INK },
          ...rows.map((r) => ({ text: pick(r), fontSize: toPt(8.5), align: 'right', color: INK })),
        ];
        els.push({
          type: 'table',
          x: toIn(x), y: toIn(cursor), w: toIn(w), h: toIn(4 * TABLE_ROW_H),
          rows: [
            head,
            money('Revenue', (r) => fmtMoney(r.revenue)),
            money('EBITDA', (r) => fmtMoney(r.ebitda)),
            [
              { text: 'EBITDA margin', italic: true, fontSize: toPt(8.5), align: 'left', color: MUTED },
              ...rows.map((r) => ({
                text: fmtMargin(r.ebitda, r.revenue),
                italic: true,
                fontSize: toPt(8.5),
                align: 'right',
                color: MUTED,
              })),
            ],
          ],
        });
        cursor += tableH;
      }

      for (const v of trackVariables) {
        const label = v.unit ? `${v.name} (${v.unit})` : v.name;
        const text = textEl(
          [{ text: `${label}: `, bold: true }, { text: v.value || '—' }],
          x,
          cursor,
          w,
          11,
          { fontSize: 8.5, color: NAVY },
        );
        if (text.type === 'text' && text.runs) text.runs[1].color = INK;
        els.push(text);
        cursor += 13;
      }

      return els;
    },
  };
}

function dealStructurePiece(company: CompanyCardCompany, currency: Currency): Piece {
  const fmtMoney = moneyFormatter(currency);
  const cap = (v: string) => `${v[0].toUpperCase()}${v.slice(1)}`;
  const lines: [string, string][] = [
    ['Deal type', company.deal_type ? cap(company.deal_type) : '—'],
    ['Target stake', company.stake && company.stake !== '—' ? company.stake : 'TBC at L1'],
    [
      'Indicative cheque size',
      company.deal_size && company.deal_size !== '—' ? company.deal_size : 'TBC at L1',
    ],
    ['Indicative valuation (EV)', fmtMoney(company.ev_2024)],
    [
      'Sourcing',
      company.banker || (company.source === 'outbound' ? 'Outbound origination' : '—'),
    ],
  ];
  const heading = sectionHeadingPiece(3, 'Proposed Deal Structure');
  const ROW_H = LINE_H + 2;

  return {
    h: SECTION_HEADING_H + lines.length * ROW_H + 4,
    render: (x, y, w) => {
      const els = [...heading.render(x, y, w)];
      lines.forEach(([label, value], i) => {
        const rowY = y + SECTION_HEADING_H + i * ROW_H;
        els.push(plainText('•', x, rowY, BULLET_INDENT, LINE_H));
        els.push(
          textEl(
            [{ text: `${label}: `, bold: true }, { text: value }],
            x + BULLET_INDENT,
            rowY,
            w - BULLET_INDENT,
            LINE_H,
          ),
        );
      });
      return els;
    },
  };
}

// ── Pagination ─────────────────────────────────────────────────────────────

interface Overflow {
  /** Numbered badge, or null for the unnumbered red "Kill criteria" label. */
  index: number | null;
  title: string;
  pieces: Piece[];
}

/**
 * Take pieces while they fit the budget; the remainder is returned for
 * continuation slides.
 *
 * `force` places the first piece even when it alone exceeds the budget. That
 * escape hatch is used ONLY when filling an empty full-height continuation
 * column, where a single oversized piece has nowhere left to go — everywhere
 * else forcing would push a later block past the slide edge, which is exactly
 * the overlap this module exists to prevent.
 */
function takeFitting(
  pieces: Piece[],
  budget: number,
  force = false,
): { taken: Piece[]; rest: Piece[] } {
  const taken: Piece[] = [];
  let used = 0;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (used + p.h > budget) {
      if (force && taken.length === 0) {
        taken.push(p);
        return { taken, rest: pieces.slice(i + 1) };
      }
      return { taken, rest: pieces.slice(i) };
    }
    taken.push(p);
    used += p.h;
  }
  return { taken, rest: [] };
}

const totalHeight = (pieces: Piece[]): number => pieces.reduce((sum, p) => sum + p.h, 0);

/**
 * Flow leftover section content onto continuation slides: three columns per
 * slide, each filled top-down, with the section heading repeated as
 * "… (cont.)" whenever a section resumes in a new column.
 */
function flowOverflowColumns(overflows: Overflow[]): Piece[][][] {
  const slides: Piece[][][] = [];
  let columns: Piece[][] = [];
  let current: Piece[] = [];
  let used = 0;

  const closeColumn = () => {
    columns.push(current);
    current = [];
    used = 0;
    if (columns.length === COL_COUNT) {
      slides.push(columns);
      columns = [];
    }
  };

  for (const section of overflows) {
    if (section.pieces.length === 0) continue;
    let index = 0;
    while (index < section.pieces.length) {
      // Everything here already spilled off an earlier slide, so every heading
      // is a continuation — including the first one in this flow.
      const heading = sectionHeadingPiece(section.index, `${section.title} (cont.)`);
      // A heading with no room for content belongs on the next column.
      if (used > 0 && used + heading.h + section.pieces[index].h > CONT_BODY_BUDGET) {
        closeColumn();
        continue;
      }
      current.push(heading);
      used += heading.h;

      // Force only in an otherwise-empty column: a piece taller than a whole
      // column has nowhere else to go, and forcing here cannot displace
      // anything because nothing follows it in this column.
      const { taken, rest } = takeFitting(
        section.pieces.slice(index),
        CONT_BODY_BUDGET - used,
        used === heading.h,
      );
      current.push(...taken);
      used += totalHeight(taken);
      index += taken.length;
      if (rest.length > 0) closeColumn();
    }
  }

  if (current.length > 0) closeColumn();
  if (columns.length > 0) {
    while (columns.length < COL_COUNT) columns.push([]);
    slides.push(columns);
  }
  return slides;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Build the slide deck for one company card: a first slide carrying the full
 * card chrome plus as much narrative as fits, followed by "(cont.)" slides for
 * anything that overflowed.
 */
export function buildCompanyCardSlides(input: CompanyCardSlideInput): CompanyCardSlide[] {
  const { company, analysis, currency, companyUrl } = input;
  const trackVariables = input.trackVariables ?? [];

  const title = companyDisplayTitle(company, 'Company');
  const sector = company.segment || '—';
  const currentStage = company.pipeline_stage || 'L0';
  const stages = input.stages ?? DEFAULT_STAGES;
  const cap = (v: string) => `${v[0].toUpperCase()}${v.slice(1)}`;

  const subtitle =
    `${company.deal_type ? `${cap(company.deal_type)} ` : ''}investment in ${sector}` +
    `${company.geography ? ` · ${company.geography}` : ''}`;

  // ── Meta + deal-status grids (identical fields to the on-screen card) ──
  const isLive = isDealLive(company);
  const advisor = company.advisor?.trim() || null;
  const sourceBy =
    company.source === 'inbound'
      ? company.banker?.trim() || null
      : company.source === 'outbound'
        ? company.entered_by_name?.trim() || null
        : null;
  const sourceValue = company.source
    ? `${cap(company.source)}${sourceBy ? ` (${sourceBy})` : ''}`
    : '—';

  const metaRow1 = metaBoxRow(
    [
      { label: 'Project Type', value: company.deal_type || 'M&A' },
      { label: 'Geography', value: company.geography || '—' },
      { label: 'Business Line', value: sector },
      { label: 'End Sector', value: sector.split('—')[0].split('-')[0].trim() },
    ],
    PAD + HEADER_H,
  );
  const metaRow2 = metaBoxRow(
    [
      { label: 'Source', value: sourceValue },
      { label: dealLeadLabel(currentStage, input.captainStageKeys), value: input.dealLead || '—' },
      {
        label: 'Deal Status',
        value: isLive ? `Live${advisor ? ` (${advisor})` : ''}` : 'Not live',
        tone: isLive ? 'live' : 'default',
      },
      { label: 'NBO Due', value: fmtDate(company.nbo_date) },
    ],
    PAD + HEADER_H + META_BOX_H + 5,
  );

  // ── Column 1: Target Overview (paginated) + Financials + Deal Structure ──
  const financials = financialsPiece(company, currency, trackVariables);
  const dealStructure = dealStructurePiece(company, currency);
  const overviewHeading = sectionHeadingPiece(1, 'Target Overview');

  const overviewPieces = narrativePieces(
    analysis?.business_overview,
    COL_W,
    'Target overview will appear here once the AI Company Card is generated.',
  );
  if (company.ownership) {
    overviewPieces.push(
      renderBlock(block('paragraph', `**Shareholding:** ${company.ownership}`), COL_W),
    );
  }

  // Financials and Deal Structure are fixed structural blocks and always sit on
  // the first slide; the overview takes only what is left over. A tight budget
  // (e.g. many surfaced track variables) simply pushes more overview to the
  // continuation slides rather than shoving Deal Structure off the bottom.
  const col1Budget = BODY_BUDGET - financials.h - dealStructure.h - overviewHeading.h;
  const overview = takeFitting(overviewPieces, col1Budget);

  // ── Column 2: Investment Thesis + Business model & value chain ──
  const thesisHeading = sectionHeadingPiece(2, 'Investment Thesis');
  const thesisPieces = narrativePieces(
    analysis?.investment_highlights,
    COL_W,
    'Investment highlights will appear here once the AI Company Card is generated.',
  );
  if (analysis?.business_model_summary?.trim()) {
    thesisPieces.push(
      renderBlock(block('subheading', 'Business model & value chain'), COL_W),
      ...parseCardMarkdown(analysis.business_model_summary).map((b) => renderBlock(b, COL_W)),
    );
  }
  const thesis = takeFitting(thesisPieces, BODY_BUDGET - thesisHeading.h);

  // ── Column 3: diligence priorities + kill criteria ──
  const diligenceHeading = sectionHeadingPiece(5, 'L1 scope of work / diligence priorities');
  const diligencePieces = narrativePieces(
    analysis?.diligence_priorities,
    COL_W,
    'Diligence priorities will appear here once the AI Company Card is generated.',
  );
  const killLabel: Piece = {
    h: SUBHEADING_H,
    render: (x, y, w) => [
      plainText('Kill criteria', x, y + 4, w, LINE_H, { fontSize: 9.5, bold: true, color: RED }),
    ],
  };
  const riskPieces = narrativePieces(
    analysis?.investment_risks,
    COL_W,
    'Investment risks will appear here once the AI Company Card is generated.',
  );

  // Reserve room for the kill-criteria block so it never gets squeezed out of
  // the first slide entirely — it is the half of column 3 readers look for.
  const col3Available = BODY_BUDGET - diligenceHeading.h - killLabel.h;
  const riskWanted = totalHeight(riskPieces);
  const diligenceBudget = col3Available - Math.min(riskWanted, Math.round(col3Available * 0.45));
  const diligence = takeFitting(diligencePieces, diligenceBudget);

  // If diligence still ate the column (a single oversized block), drop the
  // kill-criteria label too and continue the whole block on the next slide —
  // a bare "Kill criteria" heading with nothing under it is worse than none.
  const riskBudget = col3Available - totalHeight(diligence.taken);
  const risks =
    riskBudget >= LINE_H * 2
      ? takeFitting(riskPieces, riskBudget)
      : { taken: [] as Piece[], rest: riskPieces };
  const showKillLabel = risks.taken.length > 0;

  const firstSlide: CompanyCardSlide = {
    title: `${title} — Company Card`,
    elements: [
      ...headerElements(title, subtitle, currentStage, stages),
      ...metaRow1,
      ...metaRow2,
      ...renderColumn([overviewHeading, ...overview.taken, financials, dealStructure], 0, BODY_TOP),
      ...renderColumn([thesisHeading, ...thesis.taken], 1, BODY_TOP),
      ...renderColumn(
        [
          diligenceHeading,
          ...diligence.taken,
          ...(showKillLabel ? [killLabel, ...risks.taken] : []),
        ],
        2,
        BODY_TOP,
      ),
      ...footerElements(companyUrl),
    ],
  };

  const slides: CompanyCardSlide[] = [firstSlide];

  const overflowColumns = flowOverflowColumns([
    { index: 1, title: 'Target Overview', pieces: overview.rest },
    { index: 2, title: 'Investment Thesis', pieces: thesis.rest },
    { index: 5, title: 'L1 scope of work / diligence priorities', pieces: diligence.rest },
    { index: null, title: 'Kill criteria', pieces: risks.rest },
  ]);

  overflowColumns.forEach((columns, i) => {
    const contTitle = `${title} — Company Card (cont. ${i + 1})`;
    slides.push({
      title: contTitle,
      elements: [
        plainText(contTitle, PAD, PAD, SLIDE_W - PAD * 2, 15, {
          fontSize: 12,
          bold: true,
          color: NAVY,
        }),
        rect(PAD, PAD + 18, SLIDE_W - PAD * 2, 2, BLUE),
        ...columns.flatMap((pieces, col) => renderColumn(pieces, col, CONT_BODY_TOP)),
        ...footerElements(companyUrl),
      ],
    });
  });

  return slides;
}

/** Build one deck covering several company cards, in the order given. */
export function buildCompanyCardDeck(inputs: CompanyCardSlideInput[]): CompanyCardSlide[] {
  return inputs.flatMap((input) => buildCompanyCardSlides(input));
}
