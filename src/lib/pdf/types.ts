/**
 * The block vocabulary a research-summary PDF is composed from.
 *
 * This is the contract the analysis agent fills in (mirrored as Zod in
 * `src/lib/agents/analysis/tools/emailArtifacts.ts`). Layout is entirely our
 * side of the line: the agent chooses blocks and supplies data, never
 * positions or sizes.
 */

export type PillTone = 'positive' | 'negative' | 'neutral' | 'warning' | 'info';
export type GaugeTone = 'positive' | 'negative' | 'neutral';
export type PriorityTone = 'high' | 'medium' | 'low';
export type ChartAccent = 'primary' | 'secondary';
export type HeadingLevel = 'section' | 'subsection';
export type ChartKind = 'bar' | 'stacked_bar' | 'line' | 'pie';

export interface PillInput {
  label: string;
  tone: PillTone;
}

export interface KpiInput {
  label: string;
  value: string;
  hint?: string;
  /** Optional logo rendered beside the card label. */
  logoUrl?: string | null;
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
  /** Optional logo rendered beside the row label. */
  logoUrl?: string | null;
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

export interface ChartSeriesInput {
  name: string;
  values: number[];
}

export type SectionBlock =
  | { kind: 'heading'; level?: HeadingLevel; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'kpi_cards'; cards: KpiInput[] }
  | {
      /**
       * Retained for compatibility: the agent schema still accepts it and
       * `toChartSpec` folds it onto the single-series `bar` case of `chart`.
       */
      kind: 'bar_chart';
      title?: string;
      unit?: string;
      data: YearValueInput[];
      accent?: ChartAccent;
    }
  | {
      kind: 'chart';
      type: ChartKind;
      title?: string;
      unit?: string;
      categories: string[];
      series: ChartSeriesInput[];
    }
  | { kind: 'image'; url: string; caption?: string; maxHeight?: number }
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

/** Every remote image URL a document references, for the up-front fetch pass. */
export function collectImageUrls(input: ResearchSummaryPdfInput): string[] {
  const urls: string[] = [];
  for (const block of input.sections ?? []) {
    if (block.kind === 'image') urls.push(block.url);
    if (block.kind === 'kpi_cards') {
      for (const card of block.cards) if (card.logoUrl) urls.push(card.logoUrl);
    }
    if (block.kind === 'scorecard') {
      for (const row of block.rows) if (row.logoUrl) urls.push(row.logoUrl);
    }
  }
  return urls;
}
