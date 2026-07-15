import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';

// ---------- Layout constants ----------

const PAGE_WIDTH = 595.28; // A4 width in points
const PAGE_HEIGHT = 841.89; // A4 height in points
const MARGIN = 50;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const TITLE_FONT_SIZE = 20;
const SECTION_HEADING_FONT_SIZE = 14;
const SUBSECTION_HEADING_FONT_SIZE = 12;
const SUBHEADING_FONT_SIZE = 11;
const BODY_FONT_SIZE = 10.5;
const SMALL_FONT_SIZE = 9;
const LINE_HEIGHT = 14;

const KPI_CARDS_PER_ROW = 3;
const KPI_CARD_GAP = 10;
const KPI_CARD_HEIGHT = 62;
const CHART_HEIGHT = 170;
const CHART_LABEL_AREA = 22;
const QUADRANT_CELL_HEIGHT = 110;

const COLORS = {
  text: rgb(0.1, 0.1, 0.12),
  textMuted: rgb(0.42, 0.45, 0.5),
  border: rgb(0.88, 0.89, 0.92),
  cardBg: rgb(0.97, 0.98, 0.99),
  sectionAccent: rgb(0.16, 0.39, 0.85),
  // Pill tones.
  pillPositiveFg: rgb(0.06, 0.65, 0.46),
  pillPositiveBg: rgb(0.9, 0.97, 0.93),
  pillNegativeFg: rgb(0.86, 0.23, 0.27),
  pillNegativeBg: rgb(0.99, 0.92, 0.93),
  pillWarningFg: rgb(0.92, 0.6, 0.05),
  pillWarningBg: rgb(1, 0.96, 0.86),
  pillNeutralFg: rgb(0.42, 0.45, 0.5),
  pillNeutralBg: rgb(0.95, 0.95, 0.96),
  pillInfoFg: rgb(0.24, 0.51, 0.93),
  pillInfoBg: rgb(0.91, 0.95, 1),
  // Chart accents.
  chartPrimary: rgb(0.24, 0.51, 0.93),
  chartSecondary: rgb(0.45, 0.32, 0.85),
  // Quadrant tints.
  quadrantTopBg: rgb(0.99, 0.94, 0.94),
  quadrantBottomBg: rgb(0.94, 0.97, 1),
  // Priority pills (filled rectangles, white text).
  priorityHigh: rgb(0.86, 0.23, 0.27),
  priorityMedium: rgb(0.92, 0.6, 0.05),
  priorityLow: rgb(0.24, 0.51, 0.93),
  white: rgb(1, 1, 1),
};

// ---------- Input types (flexible block-based composition) ----------

export type PillTone = 'positive' | 'negative' | 'neutral' | 'warning' | 'info';
export type GaugeTone = 'positive' | 'negative' | 'neutral';
export type PriorityTone = 'high' | 'medium' | 'low';
export type ChartAccent = 'primary' | 'secondary';
export type HeadingLevel = 'section' | 'subsection';

export interface PillInput {
  label: string;
  tone: PillTone;
}

export interface KpiInput {
  label: string;
  value: string;
  hint?: string;
}

export interface YearValueInput {
  year: string;
  value: number;
}

export interface GaugeInput {
  label: string;
  valuePct: number;
  tone?: GaugeTone;
  trendLabel?: string;
}

export interface ScorecardRowInput {
  label: string;
  pill: PillInput;
  rationale: string;
}

export interface PriorityItemInput {
  priority: { label: string; tone: PriorityTone };
  description: string;
  meta?: string;
}

export interface QuadrantsInput {
  topLeft: string[];
  topRight: string[];
  bottomLeft: string[];
  bottomRight: string[];
  xLabelLow?: string;
  xLabelHigh?: string;
  yLabelHigh?: string;
  yLabelLow?: string;
}

export type SectionBlock =
  | { kind: 'heading'; level?: HeadingLevel; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'kpi_cards'; cards: KpiInput[] }
  | {
      kind: 'bar_chart';
      title?: string;
      unit?: string;
      data: YearValueInput[];
      accent?: ChartAccent;
    }
  | { kind: 'gauges'; gauges: GaugeInput[] }
  | {
      kind: 'scorecard';
      rows: ScorecardRowInput[];
      overallPill?: PillInput;
      overallNote?: string;
      columns?: { label?: string; verdict?: string; rationale?: string };
    }
  | { kind: 'quadrants'; quadrants: QuadrantsInput }
  | { kind: 'priority_list'; items: PriorityItemInput[] };

export interface ResearchSummaryPdfInput {
  title: string;
  subtitle?: string;
  sections: SectionBlock[];
  references?: Array<{ name: string; link?: string | null; date?: string | null }>;
}

// ---------- Unicode sanitization (WinAnsi -> ASCII) ----------

const UNICODE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/[‘’‚‛]/g, "'"],
  [/[“”„‟]/g, '"'],
  [/[–—―]/g, '-'],
  [/…/g, '...'],
  [/→/g, '->'],
  [/←/g, '<-'],
  [/↔/g, '<->'],
  [/≥/g, '>='],
  [/≤/g, '<='],
  [/≠/g, '!='],
  [/×/g, 'x'],
  [/±/g, '+/-'],
  [/•/g, '*'],
  [/✓/g, 'v'],
  [/✗/g, 'x'],
  [/°/g, ' deg'],
  [/€/g, 'EUR'],
  [/£/g, 'GBP'],
  [/¥/g, 'JPY'],
];

function sanitizeForWinAnsi(text: string): string {
  let out = text;
  for (const [pattern, replacement] of UNICODE_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/[^\x00-\xff]/g, '?');
}

// ---------- Render state + primitive helpers ----------

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

interface RenderState {
  doc: PDFDocument;
  page: PDFPage;
  cursorY: number;
  fonts: Fonts;
}

function newPage(state: RenderState): void {
  state.page = state.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  state.cursorY = PAGE_HEIGHT - MARGIN;
}

function ensureSpace(state: RenderState, needed: number): void {
  if (state.cursorY - needed < MARGIN) {
    newPage(state);
  }
}

function wrapLine(font: PDFFont, fontSize: number, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    const width = font.widthOfTextAtSize(candidate, fontSize);
    if (width <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      if (font.widthOfTextAtSize(word, fontSize) > maxWidth) {
        let chunk = '';
        for (const ch of word) {
          const next = chunk + ch;
          if (font.widthOfTextAtSize(next, fontSize) > maxWidth) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk = next;
          }
        }
        current = chunk;
      } else {
        current = word;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawWrapped(
  state: RenderState,
  text: string,
  opts: { font: PDFFont; size: number; indent?: number; color?: RGB; lineHeight?: number },
): void {
  const indent = opts.indent ?? 0;
  const maxWidth = CONTENT_WIDTH - indent;
  const lh = opts.lineHeight ?? LINE_HEIGHT;
  const safe = sanitizeForWinAnsi(text);
  const lines = wrapLine(opts.font, opts.size, safe, maxWidth);
  for (const line of lines) {
    ensureSpace(state, lh);
    state.cursorY -= opts.size;
    state.page.drawText(line, {
      x: MARGIN + indent,
      y: state.cursorY,
      font: opts.font,
      size: opts.size,
      color: opts.color ?? COLORS.text,
    });
    state.cursorY -= lh - opts.size;
  }
}

function drawTextAt(
  page: PDFPage,
  text: string,
  opts: { x: number; y: number; font: PDFFont; size: number; color?: RGB },
): void {
  page.drawText(sanitizeForWinAnsi(text), {
    x: opts.x,
    y: opts.y,
    font: opts.font,
    size: opts.size,
    color: opts.color ?? COLORS.text,
  });
}

function drawTextCenteredAt(
  page: PDFPage,
  text: string,
  opts: { centerX: number; y: number; font: PDFFont; size: number; color?: RGB },
): void {
  const safe = sanitizeForWinAnsi(text);
  const width = opts.font.widthOfTextAtSize(safe, opts.size);
  page.drawText(safe, {
    x: opts.centerX - width / 2,
    y: opts.y,
    font: opts.font,
    size: opts.size,
    color: opts.color ?? COLORS.text,
  });
}

// ---------- Section heading ----------

function drawSectionHeading(state: RenderState, text: string, level: HeadingLevel): void {
  const fontSize = level === 'section' ? SECTION_HEADING_FONT_SIZE : SUBSECTION_HEADING_FONT_SIZE;
  ensureSpace(state, fontSize + 22);
  state.cursorY -= level === 'section' ? 18 : 12;
  if (level === 'section') {
    state.page.drawRectangle({
      x: MARGIN,
      y: state.cursorY - 2,
      width: 3,
      height: fontSize + 4,
      color: COLORS.sectionAccent,
    });
  }
  drawTextAt(state.page, text, {
    x: MARGIN + (level === 'section' ? 10 : 0),
    y: state.cursorY,
    font: state.fonts.bold,
    size: fontSize,
  });
  state.cursorY -= 10;
}

// ---------- Pills ----------

function pillPalette(tone: PillTone): { fg: RGB; bg: RGB } {
  switch (tone) {
    case 'positive':
      return { fg: COLORS.pillPositiveFg, bg: COLORS.pillPositiveBg };
    case 'negative':
      return { fg: COLORS.pillNegativeFg, bg: COLORS.pillNegativeBg };
    case 'warning':
      return { fg: COLORS.pillWarningFg, bg: COLORS.pillWarningBg };
    case 'info':
      return { fg: COLORS.pillInfoFg, bg: COLORS.pillInfoBg };
    case 'neutral':
    default:
      return { fg: COLORS.pillNeutralFg, bg: COLORS.pillNeutralBg };
  }
}

function drawPill(
  page: PDFPage,
  font: PDFFont,
  pill: PillInput,
  opts: { x: number; y: number },
): number {
  const palette = pillPalette(pill.tone);
  const text = pill.label;
  const textWidth = font.widthOfTextAtSize(sanitizeForWinAnsi(text), SMALL_FONT_SIZE);
  const pillWidth = textWidth + 12;
  const pillHeight = 14;
  page.drawRectangle({
    x: opts.x,
    y: opts.y,
    width: pillWidth,
    height: pillHeight,
    color: palette.bg,
    borderColor: palette.fg,
    borderWidth: 0.6,
  });
  drawTextAt(page, text, {
    x: opts.x + 6,
    y: opts.y + 3,
    font,
    size: SMALL_FONT_SIZE,
    color: palette.fg,
  });
  return pillWidth;
}

// ---------- Block: paragraph ----------

function drawParagraph(state: RenderState, text: string): void {
  drawWrapped(state, text, { font: state.fonts.regular, size: BODY_FONT_SIZE });
  state.cursorY -= 4;
}

// ---------- Block: bullets ----------

function drawBullets(state: RenderState, items: string[]): void {
  if (items.length === 0) {
    drawWrapped(state, '(none)', {
      font: state.fonts.regular,
      size: BODY_FONT_SIZE,
      indent: 12,
      color: COLORS.textMuted,
    });
    return;
  }
  for (const item of items) {
    drawWrapped(state, `*  ${item}`, {
      font: state.fonts.regular,
      size: BODY_FONT_SIZE,
      indent: 12,
    });
  }
}

// ---------- Block: KPI cards ----------

function drawKpiCards(state: RenderState, cards: KpiInput[]): void {
  if (cards.length === 0) return;
  const cardWidth = (CONTENT_WIDTH - KPI_CARD_GAP * (KPI_CARDS_PER_ROW - 1)) / KPI_CARDS_PER_ROW;
  let i = 0;
  while (i < cards.length) {
    ensureSpace(state, KPI_CARD_HEIGHT + 10);
    const rowTop = state.cursorY;
    for (let col = 0; col < KPI_CARDS_PER_ROW && i < cards.length; col++, i++) {
      const card = cards[i];
      const x = MARGIN + col * (cardWidth + KPI_CARD_GAP);
      const y = rowTop - KPI_CARD_HEIGHT;
      state.page.drawRectangle({
        x,
        y,
        width: cardWidth,
        height: KPI_CARD_HEIGHT,
        color: COLORS.cardBg,
        borderColor: COLORS.border,
        borderWidth: 0.8,
      });
      drawTextAt(state.page, card.label.toUpperCase(), {
        x: x + 10,
        y: y + KPI_CARD_HEIGHT - 16,
        font: state.fonts.bold,
        size: SMALL_FONT_SIZE,
        color: COLORS.textMuted,
      });
      // Truncate value to one line.
      const valueLines = wrapLine(
        state.fonts.bold,
        14,
        sanitizeForWinAnsi(card.value),
        cardWidth - 20,
      );
      if (valueLines[0]) {
        state.page.drawText(valueLines[0], {
          x: x + 10,
          y: y + KPI_CARD_HEIGHT - 36,
          font: state.fonts.bold,
          size: 14,
          color: COLORS.text,
        });
      }
      if (card.hint) {
        const hintLines = wrapLine(
          state.fonts.regular,
          SMALL_FONT_SIZE,
          sanitizeForWinAnsi(card.hint),
          cardWidth - 20,
        );
        if (hintLines[0]) {
          state.page.drawText(hintLines[0], {
            x: x + 10,
            y: y + 12,
            font: state.fonts.regular,
            size: SMALL_FONT_SIZE,
            color: COLORS.textMuted,
          });
        }
      }
    }
    state.cursorY = rowTop - KPI_CARD_HEIGHT - 10;
  }
}

// ---------- Block: bar chart ----------

function chartAccentColor(accent: ChartAccent | undefined): RGB {
  return accent === 'secondary' ? COLORS.chartSecondary : COLORS.chartPrimary;
}

function drawBarChart(
  state: RenderState,
  block: Extract<SectionBlock, { kind: 'bar_chart' }>,
): void {
  ensureSpace(state, CHART_HEIGHT + 16);
  const top = state.cursorY;
  const x = MARGIN;
  const width = CONTENT_WIDTH;
  if (block.title) {
    drawTextAt(state.page, `${block.title}${block.unit ? ` (${block.unit})` : ''}`, {
      x,
      y: top - 12,
      font: state.fonts.bold,
      size: SUBHEADING_FONT_SIZE,
    });
  }
  const chartTop = top - 22;
  const chartBottom = top - CHART_HEIGHT + CHART_LABEL_AREA;
  const plotHeight = chartTop - chartBottom;

  // Baseline.
  state.page.drawLine({
    start: { x, y: chartBottom },
    end: { x: x + width, y: chartBottom },
    thickness: 0.8,
    color: COLORS.border,
  });

  if (block.data.length === 0) {
    drawTextAt(state.page, '(no data)', {
      x,
      y: chartBottom - 14,
      font: state.fonts.regular,
      size: SMALL_FONT_SIZE,
      color: COLORS.textMuted,
    });
    state.cursorY = top - CHART_HEIGHT - 6;
    return;
  }

  const maxValue = Math.max(...block.data.map((d) => d.value), 0);
  const minValue = Math.min(...block.data.map((d) => d.value), 0);
  const range = maxValue - minValue || 1;
  const slotWidth = width / block.data.length;
  const barWidth = Math.min(slotWidth * 0.55, 48);
  const accent = chartAccentColor(block.accent);

  for (let i = 0; i < block.data.length; i++) {
    const d = block.data[i];
    const slotX = x + i * slotWidth;
    const barX = slotX + (slotWidth - barWidth) / 2;
    const zeroY = chartBottom + (-minValue / range) * plotHeight;
    const barHeight = (d.value / range) * plotHeight;
    const barY = d.value >= 0 ? zeroY : zeroY + barHeight;
    state.page.drawRectangle({
      x: barX,
      y: barY,
      width: barWidth,
      height: Math.abs(barHeight),
      color: accent,
    });
    const valueText = `${d.value}`;
    const valueY = d.value >= 0 ? barY + Math.abs(barHeight) + 3 : barY - 10;
    drawTextCenteredAt(state.page, valueText, {
      centerX: barX + barWidth / 2,
      y: valueY,
      font: state.fonts.bold,
      size: SMALL_FONT_SIZE,
    });
    drawTextCenteredAt(state.page, d.year, {
      centerX: barX + barWidth / 2,
      y: chartBottom - 12,
      font: state.fonts.regular,
      size: SMALL_FONT_SIZE,
      color: COLORS.textMuted,
    });
  }
  state.cursorY = top - CHART_HEIGHT - 6;
}

// ---------- Block: gauges ----------

function gaugeFillColor(tone: GaugeTone | undefined): RGB {
  if (tone === 'positive') return COLORS.pillPositiveFg;
  if (tone === 'negative') return COLORS.pillNegativeFg;
  return COLORS.pillNeutralFg;
}

function drawGauges(state: RenderState, gauges: GaugeInput[]): void {
  if (gauges.length === 0) return;
  ensureSpace(state, gauges.length * 22 + 6);
  const barAreaX = MARGIN + 140;
  const barAreaWidth = CONTENT_WIDTH - 220;
  const barHeight = 8;

  for (const gauge of gauges) {
    ensureSpace(state, 22);
    const rowY = state.cursorY;
    drawTextAt(state.page, gauge.label, {
      x: MARGIN,
      y: rowY - 8,
      font: state.fonts.regular,
      size: BODY_FONT_SIZE,
    });
    state.page.drawRectangle({
      x: barAreaX,
      y: rowY - 10,
      width: barAreaWidth,
      height: barHeight,
      color: COLORS.cardBg,
      borderColor: COLORS.border,
      borderWidth: 0.5,
    });
    const fillPct = Math.max(0, Math.min(gauge.valuePct, 100));
    const fillColor = gaugeFillColor(gauge.tone);
    state.page.drawRectangle({
      x: barAreaX,
      y: rowY - 10,
      width: barAreaWidth * (fillPct / 100),
      height: barHeight,
      color: fillColor,
    });
    const valueLabel = gauge.trendLabel
      ? `${gauge.valuePct}% (${gauge.trendLabel})`
      : `${gauge.valuePct}%`;
    drawTextAt(state.page, valueLabel, {
      x: barAreaX + barAreaWidth + 8,
      y: rowY - 8,
      font: state.fonts.bold,
      size: SMALL_FONT_SIZE,
      color: fillColor,
    });
    state.cursorY -= 22;
  }
}

// ---------- Block: scorecard ----------

function drawScorecard(
  state: RenderState,
  block: Extract<SectionBlock, { kind: 'scorecard' }>,
): void {
  if (block.rows.length === 0) {
    drawWrapped(state, '(no scorecard rows)', {
      font: state.fonts.regular,
      size: BODY_FONT_SIZE,
      color: COLORS.textMuted,
    });
    return;
  }

  const labelColX = MARGIN;
  const labelColW = 150;
  const pillColX = MARGIN + labelColW + 8;
  const pillColW = 80;
  const rationaleColX = pillColX + pillColW + 8;
  const rationaleColW = CONTENT_WIDTH - (rationaleColX - MARGIN);

  const headers = {
    label: block.columns?.label ?? 'Item',
    verdict: block.columns?.verdict ?? 'Verdict',
    rationale: block.columns?.rationale ?? 'Notes',
  };

  ensureSpace(state, 22);
  state.page.drawRectangle({
    x: MARGIN,
    y: state.cursorY - 18,
    width: CONTENT_WIDTH,
    height: 18,
    color: COLORS.cardBg,
    borderColor: COLORS.border,
    borderWidth: 0.5,
  });
  drawTextAt(state.page, headers.label, {
    x: labelColX + 6,
    y: state.cursorY - 13,
    font: state.fonts.bold,
    size: SMALL_FONT_SIZE,
    color: COLORS.textMuted,
  });
  drawTextAt(state.page, headers.verdict, {
    x: pillColX,
    y: state.cursorY - 13,
    font: state.fonts.bold,
    size: SMALL_FONT_SIZE,
    color: COLORS.textMuted,
  });
  drawTextAt(state.page, headers.rationale, {
    x: rationaleColX,
    y: state.cursorY - 13,
    font: state.fonts.bold,
    size: SMALL_FONT_SIZE,
    color: COLORS.textMuted,
  });
  state.cursorY -= 18;

  for (const row of block.rows) {
    const labelLines = wrapLine(
      state.fonts.bold,
      BODY_FONT_SIZE,
      sanitizeForWinAnsi(row.label),
      labelColW - 12,
    );
    const rationaleLines = wrapLine(
      state.fonts.regular,
      BODY_FONT_SIZE,
      sanitizeForWinAnsi(row.rationale),
      rationaleColW - 8,
    );
    const rowHeight = Math.max(labelLines.length, rationaleLines.length, 1) * LINE_HEIGHT + 6;
    ensureSpace(state, rowHeight);
    const rowTop = state.cursorY;
    state.page.drawRectangle({
      x: MARGIN,
      y: rowTop - rowHeight,
      width: CONTENT_WIDTH,
      height: rowHeight,
      borderColor: COLORS.border,
      borderWidth: 0.5,
    });
    let labelY = rowTop - 12;
    for (const line of labelLines) {
      state.page.drawText(line, {
        x: labelColX + 6,
        y: labelY,
        font: state.fonts.bold,
        size: BODY_FONT_SIZE,
        color: COLORS.text,
      });
      labelY -= LINE_HEIGHT;
    }
    drawPill(state.page, state.fonts.bold, row.pill, {
      x: pillColX,
      y: rowTop - 16,
    });
    let rationaleY = rowTop - 12;
    for (const line of rationaleLines) {
      state.page.drawText(line, {
        x: rationaleColX,
        y: rationaleY,
        font: state.fonts.regular,
        size: BODY_FONT_SIZE,
        color: COLORS.text,
      });
      rationaleY -= LINE_HEIGHT;
    }
    state.cursorY = rowTop - rowHeight;
  }

  if (block.overallPill) {
    state.cursorY -= 8;
    ensureSpace(state, 20);
    const overallY = state.cursorY - 16;
    drawTextAt(state.page, 'Overall:', {
      x: MARGIN,
      y: overallY,
      font: state.fonts.bold,
      size: BODY_FONT_SIZE,
    });
    const labelW = state.fonts.bold.widthOfTextAtSize('Overall:', BODY_FONT_SIZE);
    const pillW = drawPill(state.page, state.fonts.bold, block.overallPill, {
      x: MARGIN + labelW + 8,
      y: overallY - 3,
    });
    if (block.overallNote) {
      drawTextAt(state.page, block.overallNote, {
        x: MARGIN + labelW + 8 + pillW + 8,
        y: overallY,
        font: state.fonts.regular,
        size: BODY_FONT_SIZE,
        color: COLORS.textMuted,
      });
    }
    state.cursorY -= 20;
  }
}

// ---------- Block: quadrants (2x2 matrix) ----------

function drawQuadrants(state: RenderState, q: QuadrantsInput): void {
  const axisLabelHeight = q.xLabelLow || q.xLabelHigh ? 16 : 6;
  const totalHeight = axisLabelHeight + QUADRANT_CELL_HEIGHT * 2 + 16;
  ensureSpace(state, totalHeight);
  const top = state.cursorY;

  const cellWidth = (CONTENT_WIDTH - 8) / 2;

  if (q.xLabelLow) {
    drawTextCenteredAt(state.page, q.xLabelLow.toUpperCase(), {
      centerX: MARGIN + cellWidth / 2,
      y: top - 10,
      font: state.fonts.bold,
      size: SMALL_FONT_SIZE,
      color: COLORS.textMuted,
    });
  }
  if (q.xLabelHigh) {
    drawTextCenteredAt(state.page, q.xLabelHigh.toUpperCase(), {
      centerX: MARGIN + cellWidth + 8 + cellWidth / 2,
      y: top - 10,
      font: state.fonts.bold,
      size: SMALL_FONT_SIZE,
      color: COLORS.textMuted,
    });
  }

  const gridTop = top - axisLabelHeight;
  const cells: Array<{ x: number; y: number; items: string[]; bg: RGB; emptyTone: RGB }> = [
    {
      x: MARGIN,
      y: gridTop - QUADRANT_CELL_HEIGHT,
      items: q.topLeft,
      bg: COLORS.quadrantTopBg,
      emptyTone: COLORS.textMuted,
    },
    {
      x: MARGIN + cellWidth + 8,
      y: gridTop - QUADRANT_CELL_HEIGHT,
      items: q.topRight,
      bg: COLORS.quadrantTopBg,
      emptyTone: COLORS.textMuted,
    },
    {
      x: MARGIN,
      y: gridTop - QUADRANT_CELL_HEIGHT * 2 - 8,
      items: q.bottomLeft,
      bg: COLORS.quadrantBottomBg,
      emptyTone: COLORS.textMuted,
    },
    {
      x: MARGIN + cellWidth + 8,
      y: gridTop - QUADRANT_CELL_HEIGHT * 2 - 8,
      items: q.bottomRight,
      bg: COLORS.quadrantBottomBg,
      emptyTone: COLORS.textMuted,
    },
  ];

  for (const cell of cells) {
    state.page.drawRectangle({
      x: cell.x,
      y: cell.y,
      width: cellWidth,
      height: QUADRANT_CELL_HEIGHT,
      color: cell.bg,
      borderColor: COLORS.border,
      borderWidth: 0.6,
    });
    const items = cell.items.length > 0 ? cell.items : ['(none)'];
    const isEmpty = cell.items.length === 0;
    let lineY = cell.y + QUADRANT_CELL_HEIGHT - 18;
    for (const item of items) {
      const lines = wrapLine(
        state.fonts.regular,
        BODY_FONT_SIZE,
        sanitizeForWinAnsi(item),
        cellWidth - 28,
      );
      for (let li = 0; li < lines.length; li++) {
        if (lineY < cell.y + 8) break;
        const prefix = li === 0 ? '*  ' : '   ';
        state.page.drawText(`${prefix}${lines[li]}`, {
          x: cell.x + 8,
          y: lineY,
          font: state.fonts.regular,
          size: BODY_FONT_SIZE,
          color: isEmpty ? cell.emptyTone : COLORS.text,
        });
        lineY -= LINE_HEIGHT;
      }
    }
  }

  if (q.yLabelHigh) {
    drawTextAt(state.page, q.yLabelHigh.toUpperCase(), {
      x: MARGIN + CONTENT_WIDTH + 2,
      y: gridTop - QUADRANT_CELL_HEIGHT / 2,
      font: state.fonts.bold,
      size: SMALL_FONT_SIZE,
      color: COLORS.textMuted,
    });
  }
  if (q.yLabelLow) {
    drawTextAt(state.page, q.yLabelLow.toUpperCase(), {
      x: MARGIN + CONTENT_WIDTH + 2,
      y: gridTop - QUADRANT_CELL_HEIGHT - 8 - QUADRANT_CELL_HEIGHT / 2,
      font: state.fonts.bold,
      size: SMALL_FONT_SIZE,
      color: COLORS.textMuted,
    });
  }

  state.cursorY = gridTop - QUADRANT_CELL_HEIGHT * 2 - 8 - 6;
}

// ---------- Block: priority list ----------

function priorityFill(tone: PriorityTone): RGB {
  if (tone === 'high') return COLORS.priorityHigh;
  if (tone === 'medium') return COLORS.priorityMedium;
  return COLORS.priorityLow;
}

function drawPriorityList(state: RenderState, items: PriorityItemInput[]): void {
  if (items.length === 0) {
    drawWrapped(state, '(no items)', {
      font: state.fonts.regular,
      size: BODY_FONT_SIZE,
      color: COLORS.textMuted,
    });
    return;
  }
  for (const item of items) {
    const pillFill = priorityFill(item.priority.tone);
    const pillText = item.priority.label;
    const pillTextWidth = state.fonts.bold.widthOfTextAtSize(
      sanitizeForWinAnsi(pillText),
      SMALL_FONT_SIZE,
    );
    const pillWidth = pillTextWidth + 14;
    const pillHeight = 16;
    const descLines = wrapLine(
      state.fonts.bold,
      BODY_FONT_SIZE,
      sanitizeForWinAnsi(item.description),
      CONTENT_WIDTH - pillWidth - 14,
    );
    const rowHeight = Math.max(pillHeight + 6, descLines.length * LINE_HEIGHT + (item.meta ? 18 : 6));
    ensureSpace(state, rowHeight);
    const rowTop = state.cursorY;
    state.page.drawRectangle({
      x: MARGIN,
      y: rowTop - pillHeight - 2,
      width: pillWidth,
      height: pillHeight,
      color: pillFill,
    });
    state.page.drawText(sanitizeForWinAnsi(pillText), {
      x: MARGIN + 7,
      y: rowTop - pillHeight + 2,
      font: state.fonts.bold,
      size: SMALL_FONT_SIZE,
      color: COLORS.white,
    });
    let lineY = rowTop - BODY_FONT_SIZE - 2;
    for (const line of descLines) {
      state.page.drawText(line, {
        x: MARGIN + pillWidth + 10,
        y: lineY,
        font: state.fonts.bold,
        size: BODY_FONT_SIZE,
        color: COLORS.text,
      });
      lineY -= LINE_HEIGHT;
    }
    if (item.meta) {
      drawTextAt(state.page, item.meta, {
        x: MARGIN + pillWidth + 10,
        y: lineY,
        font: state.fonts.regular,
        size: SMALL_FONT_SIZE,
        color: COLORS.textMuted,
      });
    }
    state.cursorY = rowTop - rowHeight - 4;
  }
}

// ---------- Dispatch ----------

function drawBlock(state: RenderState, block: SectionBlock): void {
  switch (block.kind) {
    case 'heading':
      drawSectionHeading(state, block.text, block.level ?? 'section');
      return;
    case 'paragraph':
      drawParagraph(state, block.text);
      return;
    case 'bullets':
      drawBullets(state, block.items);
      return;
    case 'kpi_cards':
      drawKpiCards(state, block.cards);
      return;
    case 'bar_chart':
      drawBarChart(state, block);
      return;
    case 'gauges':
      drawGauges(state, block.gauges);
      return;
    case 'scorecard':
      drawScorecard(state, block);
      return;
    case 'quadrants':
      drawQuadrants(state, block.quadrants);
      return;
    case 'priority_list':
      drawPriorityList(state, block.items);
      return;
  }
}

// ---------- Title block + references ----------

function drawTitle(state: RenderState, title: string, subtitle?: string): void {
  drawWrapped(state, title, {
    font: state.fonts.bold,
    size: TITLE_FONT_SIZE,
    lineHeight: TITLE_FONT_SIZE + 4,
  });
  state.cursorY -= 4;
  if (subtitle) {
    drawWrapped(state, subtitle, {
      font: state.fonts.regular,
      size: SMALL_FONT_SIZE,
      color: COLORS.textMuted,
    });
  }
  state.cursorY -= 6;
}

function drawReferences(
  state: RenderState,
  refs: NonNullable<ResearchSummaryPdfInput['references']>,
): void {
  drawSectionHeading(state, 'Sources', 'section');
  refs.forEach((ref, i) => {
    const dateLabel = ref.date ? ` (${ref.date})` : '';
    const linkLabel = ref.link ? ` - ${ref.link}` : '';
    drawWrapped(state, `${i + 1}. ${ref.name}${dateLabel}${linkLabel}`, {
      font: state.fonts.regular,
      size: BODY_FONT_SIZE,
      indent: 12,
    });
  });
}

// ---------- Public entrypoint ----------

/**
 * Generate a research-summary PDF from a flexible list of section blocks and
 * return the raw bytes.
 *
 * The renderer dispatches on `block.kind` for each entry in `sections`:
 *   - `heading` / `paragraph` / `bullets` — typography primitives
 *   - `kpi_cards` — 3-up bordered cards
 *   - `bar_chart` — fiscal-year bar chart
 *   - `gauges` — horizontal percentage bars with tone color
 *   - `scorecard` — table with pill verdicts (custom column labels supported)
 *   - `quadrants` — generic 2x2 matrix with customizable axis labels
 *   - `priority_list` — colored priority pill + description rows
 *
 * No section is mandatory; the caller composes whatever blocks fit the
 * document at hand. The same renderer drives M&A target evaluations, SWOT
 * analyses, daily market updates, sector deep-dives, geopolitical briefs, etc.
 */
export async function generateResearchSummaryPdf(
  input: ResearchSummaryPdfInput,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(input.title);
  doc.setCreator('Investment Brain');
  doc.setProducer('Investment Brain');

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const state: RenderState = {
    doc,
    page: doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    cursorY: PAGE_HEIGHT - MARGIN,
    fonts: { regular, bold },
  };

  drawTitle(state, input.title, input.subtitle);

  for (const block of input.sections ?? []) {
    drawBlock(state, block);
  }

  if (input.references && input.references.length > 0) {
    drawReferences(state, input.references);
  }

  const bytes = await doc.save();
  return Buffer.from(bytes);
}
