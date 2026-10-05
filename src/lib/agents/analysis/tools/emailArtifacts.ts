/**
 * Shared email-artifact builders for the composite `send_email` tool.
 *
 * These functions build the *contents* of an email (an Excel workbook, a
 * research-summary PDF, or a flexible PowerPoint) as ready-to-attach buffers,
 * but never send anything. `send_email` composes whichever artifacts the agent
 * asked for and delivers them in a SINGLE email — so a body + spreadsheet + PDF
 * (+ PPTX for Workforce) arrive together instead of as disjointed messages.
 *
 * Zod sub-schemas for each artifact spec live here too, so the tool file just
 * nests them under its top-level schema.
 */
import { z } from 'zod';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import {
  CompanyRepository,
  CompanyFinancialRepository,
  CompanyScreeningDerivedRepository,
  CompanyFxAdjustmentRepository,
  CompanyAnalysisRepository,
  UserRepository,
  type Tables,
} from '@/lib/repositories';
import {
  COMPANY_FILTER_DOC,
  companyFilterShape,
  mapCompanyFilters,
  mergeGraphFilter,
  resolveCompanyGraphFilter,
  summarizeCompanyFilters,
  type GraphDeps,
} from './companyFilters';
import {
  generateCompanyExcel,
  type ExcelSheet,
  type ExcelCellValue,
} from '@/lib/companyExcel';
import {
  generateResearchSummaryPdf,
  type ResearchSummaryPdfInput,
  type SectionBlock,
  type KpiInput,
  type YearValueInput,
  type GaugeInput,
  type ScorecardRowInput,
  type PriorityItemInput,
  type QuadrantsInput,
  type PillInput,
} from '@/lib/pdfSummary';
import type { EmailAttachment } from '@/lib/ses';
import { isDealLive } from '@/lib/dealStatus';
import {
  CompanyNotFoundForCardError,
  type CompanyCardDeck,
} from '@/lib/services/companyCardSlideService';
import { exportElementsToPptx } from '@/lib/pptx/writePptx';
import type { PptxSlide } from '@/lib/pptx/pptxElements';
import { generatePptxBuffer } from '@/lib/pptx/generatePptxBuffer';
import { buildAgentPresentationPrompt } from '@/lib/pptx/presentationPrompt';
import { buildPresentationCompanyContext } from '@/lib/pptx/companyContext';

const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const PPTX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Slugify a title for use as an attachment filename. */
export function slugifyTitle(title: string, fallback: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || fallback
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Company Excel artifact
// ───────────────────────────────────────────────────────────────────────────

/**
 * Spec the agent passes to attach a comprehensive company Excel workbook.
 *
 * Shares the exact filter vocabulary of `query_companies` via
 * `companyFilterShape`, so any cohort the agent can list it can also export —
 * including by `company_ids`, the ids `query_companies` prints. The intended
 * flow is query first, then export the ids that came back.
 */
export const companyExcelSpecSchema = z.object({
  ...companyFilterShape,
  title: z
    .string()
    .optional()
    .describe('Optional title for the workbook (used in the file). Defaults to a filter-derived title.'),
});

export type CompanyExcelSpec = z.infer<typeof companyExcelSpecSchema>;

/** One-line, human-readable summary of the active filters (for email + title). */
export function summarizeFilters(spec: CompanyExcelSpec): string {
  return summarizeCompanyFilters(spec);
}

const round = (n: number | null | undefined, digits = 2): number | null =>
  n == null ? null : Number(n.toFixed(digits));

/**
 * Assemble the comprehensive multi-sheet workbook contents from the joined
 * company data. Kept as a pure function so the join → sheet mapping is testable
 * independently of the DB and email plumbing.
 */
export function buildCompanySheets(data: {
  companies: Tables<'companies'>[];
  financials: Tables<'company_financials'>[];
  screening: Tables<'company_screening_derived'>[];
  fx: Tables<'company_fx_adjustments'>[];
  userNamesById: Map<string, string>;
}): ExcelSheet[] {
  const { companies, financials, screening, fx, userNamesById } = data;
  const targetById = new Map(
    companies.map((c) => [c.id, c.target || c.project_name || c.id]),
  );
  const userName = (id: string | null | undefined): string =>
    id ? userNamesById.get(id) ?? '' : '';

  // Latest financial year per company for the summary columns on the main sheet.
  const latestFinByCompany = new Map<string, Tables<'company_financials'>>();
  for (const f of financials) {
    const cur = latestFinByCompany.get(f.company_id);
    if (!cur || f.fiscal_year > cur.fiscal_year) {
      latestFinByCompany.set(f.company_id, f);
    }
  }

  const companiesSheet: ExcelSheet = {
    name: 'Companies',
    columns: [
      { header: 'Entry ID', key: 'entry_id', width: 10 },
      { header: 'Target', key: 'target', width: 28 },
      { header: 'Project Name', key: 'project_name', width: 22 },
      { header: 'Segment', key: 'segment' },
      { header: 'Related Offerings', key: 'segment_related_offerings', width: 26 },
      { header: 'Company Focus', key: 'company_focus', width: 30 },
      { header: 'Geography', key: 'geography' },
      { header: 'Ownership', key: 'ownership' },
      { header: 'Website', key: 'website', width: 26 },
      { header: 'Pipeline Stage', key: 'pipeline_stage', width: 14 },
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Source', key: 'source', width: 10 },
      { header: 'Deal Type', key: 'deal_type', width: 12 },
      { header: 'Watchlist Status', key: 'watchlist_status' },
      { header: 'Workflow Status', key: 'workflow_status' },
      { header: 'Deal Sponsor', key: 'deal_sponsor' },
      { header: 'Deal Captain', key: 'deal_captain' },
      { header: 'Entered By', key: 'entered_by' },
      { header: 'Dropped By', key: 'dropped_by' },
      { header: 'Originator', key: 'originator' },
      { header: 'Banker', key: 'banker' },
      { header: 'Advisor', key: 'advisor' },
      { header: 'Live Process', key: 'is_live', width: 12 },
      { header: 'NBO Date', key: 'nbo_date', width: 12 },
      { header: 'Stake', key: 'stake', width: 12 },
      { header: 'Deal Size', key: 'deal_size', width: 14 },
      { header: 'Key Rationale', key: 'key_rationale', width: 30 },
      { header: 'AI Opinion', key: 'ai_opinion_verdict', width: 12 },
      { header: 'AI Opinion Summary', key: 'ai_opinion_summary', width: 40 },
      { header: 'AI Opinion Status', key: 'ai_opinion_status', width: 14 },
      { header: 'Latest FY', key: 'latest_fy', width: 10 },
      { header: 'Revenue (USD M)', key: 'latest_revenue', width: 16 },
      { header: 'EBITDA (USD M)', key: 'latest_ebitda', width: 16 },
      { header: 'EBITDA Margin %', key: 'latest_margin', width: 16 },
      { header: 'EV (USD M)', key: 'latest_ev', width: 14 },
      { header: 'EV/EBITDA', key: 'latest_ev_ebitda', width: 12 },
      { header: 'Comments', key: 'comments', width: 30 },
      { header: 'Remarks', key: 'remarks', width: 30 },
      { header: 'Dropped Reason', key: 'dropped_reason', width: 24 },
      { header: 'Created At', key: 'created_at', width: 22 },
      { header: 'Updated At', key: 'updated_at', width: 22 },
      { header: 'Last Activity At', key: 'last_activity_at', width: 22 },
    ],
    rows: companies.map((c): Record<string, ExcelCellValue> => {
      const f = latestFinByCompany.get(c.id);
      return {
        entry_id: c.entry_id,
        target: c.target,
        project_name: c.project_name,
        segment: c.segment,
        segment_related_offerings: c.segment_related_offerings,
        company_focus: c.company_focus,
        geography: c.geography,
        ownership: c.ownership,
        website: c.website,
        pipeline_stage: c.pipeline_stage,
        status: c.status,
        source: c.source,
        deal_type: c.deal_type,
        watchlist_status: c.watchlist_status,
        workflow_status: c.workflow_status,
        deal_sponsor: userName(c.deal_sponsor),
        deal_captain: userName(c.deal_captain),
        entered_by: userName(c.entered_by),
        dropped_by: userName(c.dropped_by),
        originator: c.originator,
        banker: c.banker,
        advisor: c.advisor,
        // Export the EFFECTIVE live status, matching what the app shows and what
        // the `is_live` filter selects on. The raw column is null for the common
        // case of a deal that is live purely because an advisor is engaged.
        is_live: isDealLive(c),
        nbo_date: c.nbo_date,
        stake: c.stake,
        deal_size: c.deal_size,
        key_rationale: c.key_rationale,
        ai_opinion_verdict: c.ai_opinion_verdict,
        ai_opinion_summary: c.ai_opinion_summary,
        ai_opinion_status: c.ai_opinion_status,
        latest_fy: f?.fiscal_year ?? null,
        latest_revenue: round(f?.revenue_usd_mn),
        latest_ebitda: round(f?.ebitda_usd_mn),
        latest_margin: f?.ebitda_margin != null ? round(f.ebitda_margin * 100) : null,
        latest_ev: round(f?.ev_usd_mn),
        latest_ev_ebitda: round(f?.ev_ebitda),
        comments: c.comments,
        remarks: c.remarks,
        dropped_reason: c.dropped_reason,
        created_at: c.created_at,
        updated_at: c.updated_at,
        last_activity_at: c.last_activity_at,
      };
    }),
  };

  const financialsSheet: ExcelSheet = {
    name: 'Financials by Year',
    columns: [
      { header: 'Target', key: 'target', width: 28 },
      { header: 'Fiscal Year', key: 'fiscal_year', width: 12 },
      { header: 'Revenue (USD M)', key: 'revenue_usd_mn', width: 16 },
      { header: 'EBITDA (USD M)', key: 'ebitda_usd_mn', width: 16 },
      { header: 'EV (USD M)', key: 'ev_usd_mn', width: 14 },
      { header: 'EBITDA Margin %', key: 'ebitda_margin', width: 16 },
      { header: 'EV/EBITDA', key: 'ev_ebitda', width: 12 },
      { header: 'Revenue CAGR vs Prior %', key: 'revenue_cagr_vs_prior', width: 22 },
    ],
    rows: financials.map((f): Record<string, ExcelCellValue> => ({
      target: targetById.get(f.company_id) ?? f.company_id,
      fiscal_year: f.fiscal_year,
      revenue_usd_mn: round(f.revenue_usd_mn),
      ebitda_usd_mn: round(f.ebitda_usd_mn),
      ev_usd_mn: round(f.ev_usd_mn),
      ebitda_margin: f.ebitda_margin != null ? round(f.ebitda_margin * 100) : null,
      ev_ebitda: round(f.ev_ebitda),
      revenue_cagr_vs_prior:
        f.revenue_cagr_vs_prior != null ? round(f.revenue_cagr_vs_prior * 100) : null,
    })),
  };

  const screeningSheet: ExcelSheet = {
    name: 'Screening',
    columns: [
      { header: 'Target', key: 'target', width: 28 },
      { header: 'L1 Result', key: 'l1_screening_result', width: 14 },
      { header: 'L1 Rationale', key: 'l1_rationale', width: 40 },
      { header: 'L0 Revenue 2024 (USD M)', key: 'l0_revenue_2024_usd_mn', width: 20 },
      { header: 'L0 EBITDA 2024 (USD M)', key: 'l0_ebitda_2024_usd_mn', width: 20 },
      { header: 'L0 EV 2024 (USD M)', key: 'l0_ev_2024_usd_mn', width: 18 },
      { header: 'L0 EV/EBITDA 2024', key: 'l0_ev_ebitda_2024', width: 16 },
      { header: 'Segment Revenue', key: 'segment_revenue', width: 16 },
      { header: 'Segment EBITDA', key: 'segment_ebitda', width: 16 },
      { header: 'Segment Rev %', key: 'segment_specific_revenue_pct', width: 14 },
      { header: '% From Domestic', key: 'pct_from_domestic', width: 16 },
      { header: 'Revenue From Priority Geo', key: 'revenue_from_priority_geo', width: 22 },
      { header: 'L1 Revenue CAGR L3Y', key: 'l1_revenue_cagr_l3y', width: 18 },
      { header: 'L1 Vision Fit', key: 'l1_vision_fit', width: 14 },
      { header: 'L1 Priority Geo', key: 'l1_priority_geo', width: 14 },
      { header: 'FX Currency', key: 'fx_currency', width: 12 },
      { header: 'FX Rationale', key: 'fx_rationale', width: 30 },
      { header: 'Computed At', key: 'computed_at', width: 22 },
    ],
    rows: screening.map((s): Record<string, ExcelCellValue> => ({
      target: targetById.get(s.company_id) ?? s.company_id,
      l1_screening_result: s.l1_screening_result,
      l1_rationale: s.l1_rationale,
      l0_revenue_2024_usd_mn: round(s.l0_revenue_2024_usd_mn),
      l0_ebitda_2024_usd_mn: round(s.l0_ebitda_2024_usd_mn),
      l0_ev_2024_usd_mn: round(s.l0_ev_2024_usd_mn),
      l0_ev_ebitda_2024: round(s.l0_ev_ebitda_2024),
      segment_revenue: round(s.segment_revenue),
      segment_ebitda: round(s.segment_ebitda),
      segment_specific_revenue_pct: round(s.segment_specific_revenue_pct),
      pct_from_domestic: round(s.pct_from_domestic),
      revenue_from_priority_geo: s.revenue_from_priority_geo,
      l1_revenue_cagr_l3y: round(s.l1_revenue_cagr_l3y),
      l1_vision_fit: s.l1_vision_fit,
      l1_priority_geo: s.l1_priority_geo,
      fx_currency: s.fx_currency,
      fx_rationale: s.fx_rationale,
      computed_at: s.computed_at,
    })),
  };

  const fxSheet: ExcelSheet = {
    name: 'FX Adjustments',
    columns: [
      { header: 'Target', key: 'target', width: 28 },
      { header: 'Fiscal Year', key: 'fiscal_year', width: 12 },
      { header: 'Currency', key: 'currency', width: 12 },
      { header: 'Revenue (Local)', key: 'revenue_local', width: 16 },
      { header: 'EBITDA (Local)', key: 'ebitda_local', width: 16 },
      { header: 'Assumed Forex', key: 'assumed_forex', width: 16 },
      { header: 'Forex Change vs Prior %', key: 'forex_change_vs_prior', width: 22 },
      { header: 'Revenue CAGR Domestic %', key: 'revenue_cagr_domestic', width: 22 },
    ],
    rows: fx.map((x): Record<string, ExcelCellValue> => ({
      target: targetById.get(x.company_id) ?? x.company_id,
      fiscal_year: x.fiscal_year,
      currency: x.currency,
      revenue_local: round(x.revenue_local),
      ebitda_local: round(x.ebitda_local),
      assumed_forex: round(x.assumed_forex, 4),
      forex_change_vs_prior:
        x.forex_change_vs_prior != null ? round(x.forex_change_vs_prior * 100) : null,
      revenue_cagr_domestic:
        x.revenue_cagr_domestic != null ? round(x.revenue_cagr_domestic * 100) : null,
    })),
  };

  // Always include the Companies sheet; only include detail sheets that have rows.
  const sheets: ExcelSheet[] = [companiesSheet];
  if (financialsSheet.rows.length > 0) sheets.push(financialsSheet);
  if (screeningSheet.rows.length > 0) sheets.push(screeningSheet);
  if (fxSheet.rows.length > 0) sheets.push(fxSheet);
  return sheets;
}

export interface CompanyExcelArtifact {
  attachment: EmailAttachment;
  title: string;
  companyCount: number;
  filterSummary: string;
  /** Human-readable notes (e.g. an unresolved connected_to name). */
  notes: string[];
}

/**
 * Wire the relationship-graph resolver. Imported lazily for the same reason as
 * the Company Card path below: a static import of the service container would
 * close an import cycle back onto this module (container → aiWorkforceService
 * → workforce → agents → tools → emailArtifacts).
 */
async function buildGraphDeps(
  db: ReturnType<typeof createDb>,
  workspaceId: string,
  companyRepo: CompanyRepository,
): Promise<GraphDeps> {
  const { createContainer } = await import('@/lib/services/container');
  const { companyGraphService } = createContainer(db, workspaceId);
  return {
    resolveCompany: async (nameOrId: string) => {
      const match = await companyRepo.findByNameFuzzy(nameOrId);
      return match
        ? { id: match.id, name: match.target || match.project_name || nameOrId }
        : null;
    },
    getConnectedCompanies: (id: string) => companyGraphService.getConnectedCompanies(id),
    getGraphData: () => companyGraphService.getGraphData(),
  };
}

/**
 * Fetch the comprehensive joined company data set for the given filters and
 * render it into a ready-to-attach .xlsx buffer. Returns `null` when the
 * filter matches no companies (the caller should tell the user nothing was
 * attached rather than mail an empty workbook).
 */
export async function buildCompanyExcelAttachment(
  spec: CompanyExcelSpec,
): Promise<CompanyExcelArtifact | null> {
  const db = createDb();
  const workspaceId = await getActiveWorkspaceId();

  const companyRepo = new CompanyRepository(db, workspaceId);

  const graph = await resolveCompanyGraphFilter(spec, () =>
    buildGraphDeps(db, workspaceId, companyRepo),
  );
  if (graph.error) throw new Error(graph.error);
  const notes = [...graph.notes];

  // NOTE: unlike query_companies / get_company_stats, the export deliberately
  // has NO stage default — "email me the pipeline as a spreadsheet" with no
  // filters must mean every stage, not just the L0–L5 funnel. Narrowing here
  // would silently drop intake rows from a workbook the user asked for in full.
  const filters = mergeGraphFilter(mapCompanyFilters(spec), graph);
  // `include_pre_pipeline` still has to do something here: findForAgentStats
  // drops `discovered` relationship-graph stubs unless a stage filter names
  // them, so asking for the pre-pipeline stages must name them explicitly.
  if (
    spec.include_pre_pipeline &&
    !spec.stage &&
    !(spec.stage_in && spec.stage_in.length > 0) &&
    !spec.company_ids
  ) {
    filters.stageNotIn = [];
  }

  const companies = await companyRepo.findForAgentStats(filters);
  if (companies.length === 0) {
    return null;
  }

  const ids = companies.map((c) => c.id);
  const [financials, screening, fx] = await Promise.all([
    new CompanyFinancialRepository(db, workspaceId).findByCompanies(ids),
    new CompanyScreeningDerivedRepository(db, workspaceId).findByCompanies(ids),
    new CompanyFxAdjustmentRepository(db, workspaceId).findByCompanies(ids),
  ]);

  const userIds = Array.from(
    new Set(
      companies
        .flatMap((c) => [c.deal_sponsor, c.deal_captain, c.entered_by, c.dropped_by])
        .filter((v): v is string => Boolean(v)),
    ),
  );
  const users = await new UserRepository(db).findByIds(userIds);
  const userNamesById = new Map(users.map((u) => [u.id, u.name]));

  const sheets = buildCompanySheets({
    companies,
    financials,
    screening,
    fx,
    userNamesById,
  });

  const filterSummary = summarizeFilters(spec);
  const title = spec.title?.trim() || `Company export - ${filterSummary}`.slice(0, 120);
  const generatedAt = new Date().toISOString();

  const excelBuffer = await generateCompanyExcel({ title, generatedAt, sheets });

  return {
    attachment: {
      filename: `${slugifyTitle(title, 'company-export')}.xlsx`,
      content: excelBuffer,
      contentType: XLSX_CONTENT_TYPE,
    },
    title,
    companyCount: companies.length,
    filterSummary,
    notes,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Research-summary PDF artifact
// ───────────────────────────────────────────────────────────────────────────

const pillSchema = z.object({
  label: z.string().describe('Short pill text, e.g. "PASS", "STRENGTH", "URGENT", "POSITIVE", "INFO"'),
  tone: z
    .enum(['positive', 'negative', 'neutral', 'warning', 'info'])
    .describe('Pill color: positive=green, negative=red, warning=amber, info=blue, neutral=gray'),
});

const kpiSchema = z.object({
  label: z.string().describe('Short uppercase-able card label'),
  value: z.string().describe('Single-line headline value'),
  hint: z.string().optional().describe('Optional one-line context under the value'),
});

const yearValueSchema = z.object({
  year: z.string().describe('X-axis label, e.g. "FY2024", "2024 Q1", "Mar"'),
  value: z.number().describe('Numeric value for the bar height'),
});

const gaugeSchema = z.object({
  label: z.string().describe('Gauge label, e.g. "EBITDA margin", "Sentiment", "Approval %"'),
  valuePct: z.number().describe('Fill percentage 0–100'),
  tone: z
    .enum(['positive', 'negative', 'neutral'])
    .optional()
    .describe('Bar fill color: positive=green, negative=red, neutral=gray'),
  trendLabel: z
    .string()
    .optional()
    .describe('Optional inline label after the value, e.g. "rising", "vs Q4: +3pp"'),
});

const scorecardRowSchema = z.object({
  label: z.string().describe('Row label, e.g. a criterion, a player, a metric'),
  pill: pillSchema,
  rationale: z.string().describe('One-sentence note rendered in the rationale column'),
});

const priorityItemSchema = z.object({
  priority: z.object({
    label: z.string().describe('Short tag shown in the colored pill, e.g. "P1", "URGENT", "WATCH"'),
    tone: z.enum(['high', 'medium', 'low']).describe('Pill color: high=red, medium=amber, low=blue'),
  }),
  description: z.string().describe('Bolded action / item line'),
  meta: z
    .string()
    .optional()
    .describe('Optional muted meta line below the description, e.g. "Owner: Workforce - Due: this week"'),
});

const quadrantsSchema = z.object({
  topLeft: z.array(z.string()).default([]),
  topRight: z.array(z.string()).default([]),
  bottomLeft: z.array(z.string()).default([]),
  bottomRight: z.array(z.string()).default([]),
  xLabelLow: z.string().optional().describe('X-axis label rendered above the left column'),
  xLabelHigh: z.string().optional().describe('X-axis label rendered above the right column'),
  yLabelHigh: z.string().optional().describe('Y-axis label rendered next to the top row'),
  yLabelLow: z.string().optional().describe('Y-axis label rendered next to the bottom row'),
});

const sectionBlockSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('heading'),
    level: z.enum(['section', 'subsection']).optional(),
    text: z.string(),
  }),
  z.object({ kind: z.literal('paragraph'), text: z.string() }),
  z.object({ kind: z.literal('bullets'), items: z.array(z.string()) }),
  z.object({ kind: z.literal('kpi_cards'), cards: z.array(kpiSchema).min(1).max(12) }),
  z.object({
    kind: z.literal('bar_chart'),
    title: z.string().optional(),
    unit: z.string().optional(),
    data: z.array(yearValueSchema).min(1).max(12),
    accent: z.enum(['primary', 'secondary']).optional(),
  }),
  z.object({ kind: z.literal('gauges'), gauges: z.array(gaugeSchema).min(1).max(8) }),
  z.object({
    kind: z.literal('scorecard'),
    rows: z.array(scorecardRowSchema).min(1),
    overallPill: pillSchema.optional(),
    overallNote: z.string().optional(),
    columns: z
      .object({
        label: z.string().optional(),
        verdict: z.string().optional(),
        rationale: z.string().optional(),
      })
      .optional(),
  }),
  z.object({ kind: z.literal('quadrants'), quadrants: quadrantsSchema }),
  z.object({ kind: z.literal('priority_list'), items: z.array(priorityItemSchema).min(1) }),
]);

const referenceSchema = z.object({
  name: z.string(),
  link: z.string().optional(),
  date: z.string().optional(),
});

/** Spec the agent passes to attach a formatted research-summary PDF. */
export const researchSummarySpecSchema = z.object({
  title: z.string().describe('Document title (used for the PDF and its filename slug).'),
  sections: z
    .array(sectionBlockSchema)
    .min(1)
    .describe('Ordered list of rendered blocks. Compose freely; no required structure.'),
  references: z.array(referenceSchema).optional().describe('Optional source list rendered at the end.'),
});

export type ResearchSummarySpec = z.infer<typeof researchSummarySpecSchema>;

function mapSection(s: ResearchSummarySpec['sections'][number]): SectionBlock {
  switch (s.kind) {
    case 'heading':
      return { kind: 'heading', level: s.level, text: s.text };
    case 'paragraph':
      return { kind: 'paragraph', text: s.text };
    case 'bullets':
      return { kind: 'bullets', items: s.items };
    case 'kpi_cards':
      return { kind: 'kpi_cards', cards: s.cards as KpiInput[] };
    case 'bar_chart':
      return {
        kind: 'bar_chart',
        title: s.title,
        unit: s.unit,
        data: s.data as YearValueInput[],
        accent: s.accent,
      };
    case 'gauges':
      return { kind: 'gauges', gauges: s.gauges as GaugeInput[] };
    case 'scorecard':
      return {
        kind: 'scorecard',
        rows: s.rows as ScorecardRowInput[],
        overallPill: s.overallPill as PillInput | undefined,
        overallNote: s.overallNote,
        columns: s.columns,
      };
    case 'quadrants':
      return { kind: 'quadrants', quadrants: s.quadrants as QuadrantsInput };
    case 'priority_list':
      return { kind: 'priority_list', items: s.items as PriorityItemInput[] };
  }
}

export interface ResearchSummaryArtifact {
  attachment: EmailAttachment;
  title: string;
}

/**
 * Render a research-summary spec into a ready-to-attach PDF buffer. The
 * `preparedFor` label is stamped into the document subtitle.
 */
export async function buildResearchSummaryAttachment(
  spec: ResearchSummarySpec,
  preparedFor?: string,
): Promise<ResearchSummaryArtifact> {
  const dateLabel = new Date().toISOString().slice(0, 10);
  const subtitle = preparedFor
    ? `Prepared for ${preparedFor} - ${dateLabel}`
    : `Prepared ${dateLabel}`;
  const pdfInput: ResearchSummaryPdfInput = {
    title: spec.title,
    subtitle,
    sections: spec.sections.map(mapSection),
    references: spec.references?.map((r) => ({
      name: r.name,
      link: r.link ?? null,
      date: r.date ?? null,
    })),
  };

  const pdfBuffer = await generateResearchSummaryPdf(pdfInput);

  return {
    attachment: {
      filename: `${slugifyTitle(spec.title, 'research-summary')}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
    },
    title: spec.title,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Flexible PowerPoint (pptx skill) artifact — Workforce only via send_email
// ───────────────────────────────────────────────────────────────────────────

/** Spec the Workforce agent passes to attach a flexible .pptx deck. */
export const presentationSpecSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(200)
    .describe('Deck title (also used for the attachment filename).'),
  brief: z
    .string()
    .min(1)
    .max(12_000)
    .describe(
      'Free-form brief: topic, outline, tone, must-include facts. Slide count and structure are flexible — do NOT force a fixed 7-slide template.',
    ),
  company_names: z
    .array(z.string())
    .optional()
    .describe(
      'Optional pipeline company names to fuzzy-resolve and append as structured context for the deck.',
    ),
});

export type PresentationSpec = z.infer<typeof presentationSpecSchema>;

export interface PresentationArtifact {
  attachment: EmailAttachment;
  title: string;
  /** Human-readable notes (e.g. unresolved company_names). */
  notes: string[];
}

// ───────────────────────────────────────────────────────────────────────────
// Company Card PowerPoint artifact — the on-screen "L0 → L1 Submission" card
// ───────────────────────────────────────────────────────────────────────────

/**
 * Cards are built one at a time (each is a separate data assembly + layout
 * pass), so the deck size is capped rather than left to whatever list the agent
 * decides to paste in. A deck this large already strains the SES attachment
 * budget anyway.
 */
const MAX_CARD_COMPANIES = 25;

/**
 * Spec the agent passes to attach the Company Card deck for one or more
 * companies. `company_ids` is the preferred addressing mode — run
 * `query_companies` first and hand back the ids it printed, so the deck covers
 * exactly the rows the user saw with no fuzzy-name ambiguity. `company_names`
 * remains for the case where the user named a company that was never queried.
 */
export const companyCardSpecSchema = z.object({
  company_ids: z
    .array(z.string().min(1))
    .max(MAX_CARD_COMPANIES)
    .optional()
    .describe(
      `Company IDs (uuids) from a previous query_companies result. Preferred over company_names — exact, no fuzzy matching. One card per id, in this order. Max ${MAX_CARD_COMPANIES}.`,
    ),
  company_names: z
    .array(z.string().min(1))
    .max(MAX_CARD_COMPANIES)
    .optional()
    .describe(
      `Pipeline company names (target or project name) whose Company Card should be exported. Use only when you have no id. One card per company, in this order. Max ${MAX_CARD_COMPANIES}.`,
    ),
  title: z
    .string()
    .optional()
    .describe(
      'Optional deck title, used for the attachment filename. Defaults to the company name (or "Company cards" for several).',
    ),
});

export type CompanyCardSpec = z.infer<typeof companyCardSpecSchema>;

export interface CompanyCardArtifact {
  attachment: EmailAttachment;
  title: string;
  /** Companies whose card made it into the deck, in deck order. */
  companyTitles: string[];
  slideCount: number;
  /** Human-readable notes (e.g. names that could not be resolved). */
  notes: string[];
}

/**
 * `CompanyRepository.findById` reports a missing row as `Company <id> not
 * found`, which surfaces through `buildById`. Recognise exactly that so a bad
 * id from the agent degrades to an "unresolved" note while any other failure
 * (render error, DB outage) still propagates.
 */
function isMissingCompanyError(err: unknown, id: string): boolean {
  return err instanceof Error && err.message === `Company ${id} not found`;
}

/**
 * Render the Company Card for each requested company into a single .pptx,
 * laid out exactly like the Overview tab of the company detail dialog.
 *
 * Companies are addressed by id first (`company_ids`, as printed by
 * `query_companies`) and by name only as a fallback — an id from a prior query
 * is exact, whereas a name goes through fuzzy matching and can land on the
 * wrong record. Ids and names are deduplicated against each other so naming the
 * same company both ways doesn't produce the card twice.
 *
 * Returns `null` when nothing resolves, so the caller can say so instead of
 * mailing an empty deck.
 */
export async function buildCompanyCardAttachment(
  spec: CompanyCardSpec,
  opts?: { workspaceId?: string },
): Promise<CompanyCardArtifact | null> {
  const requestedIds = (spec.company_ids ?? []).map((id) => id.trim()).filter(Boolean);
  const requestedNames = (spec.company_names ?? []).map((n) => n.trim()).filter(Boolean);
  if (requestedIds.length === 0 && requestedNames.length === 0) {
    throw new Error('company_card needs company_ids (preferred) or company_names.');
  }

  const db = createDb();
  const workspaceId = opts?.workspaceId ?? (await getActiveWorkspaceId());
  // Imported lazily: the service container transitively reaches the agent tool
  // registry (container → aiWorkforceService → workforce → agents → tools),
  // so a static import here would close an import cycle back onto this module
  // and leave `send_email`'s schemas undefined at evaluation time.
  const { createContainer } = await import('@/lib/services/container');
  const { companyCardSlideService } = createContainer(db, workspaceId);

  const slides: PptxSlide[] = [];
  const companyTitles: string[] = [];
  const unresolved: string[] = [];
  // Ids and names can address the same company; dedupe on the resolved company
  // id, not the display title — two records can share a name, and an unnamed one
  // falls back to a placeholder, so titles would collapse distinct companies.
  const seenIds = new Set<string>();

  const appendDeck = async (build: () => Promise<CompanyCardDeck>) => {
    const deck = await build();
    if (seenIds.has(deck.companyId)) return;
    seenIds.add(deck.companyId);
    companyTitles.push(deck.title);
    slides.push(...deck.slides);
  };

  for (const id of requestedIds) {
    try {
      await appendDeck(() => companyCardSlideService.buildById(id));
    } catch (err) {
      // buildById throws a plain Error for an unknown id; treat that the same
      // way as an unresolvable name rather than failing the whole email.
      if (err instanceof CompanyNotFoundForCardError || isMissingCompanyError(err, id)) {
        unresolved.push(id);
        continue;
      }
      throw err;
    }
  }

  for (const name of requestedNames) {
    try {
      await appendDeck(() => companyCardSlideService.buildByName(name));
    } catch (err) {
      if (err instanceof CompanyNotFoundForCardError) {
        unresolved.push(name);
        continue;
      }
      throw err;
    }
  }

  const notes: string[] = [];
  if (unresolved.length > 0) {
    notes.push(
      `Could not resolve compan${unresolved.length === 1 ? 'y' : 'ies'} for the Company Card deck: ${unresolved.join(', ')}.`,
    );
  }
  if (slides.length === 0) return null;

  const title =
    spec.title?.trim() ||
    (companyTitles.length === 1 ? `${companyTitles[0]} — Company Card` : 'Company cards');

  const buffer = await exportElementsToPptx(slides);

  return {
    attachment: {
      filename: `${slugifyTitle(title, 'company-card')}.pptx`,
      content: buffer,
      contentType: PPTX_CONTENT_TYPE,
    },
    title,
    companyTitles,
    slideCount: slides.length,
    notes,
  };
}

/**
 * Build a .pptx via the Anthropic pptx skill and return a ready-to-attach buffer.
 * Throws on generation failure or oversize (caller should surface as tool error).
 */
export async function buildPresentationAttachment(
  spec: PresentationSpec,
  opts?: {
    onHeartbeat?: () => void | Promise<void>;
    workspaceId?: string;
    /** Remaining attachment budget in bytes (defaults to PPTX_MAX_EMAIL_BYTES). */
    maxBytes?: number;
    signal?: AbortSignal;
  },
): Promise<PresentationArtifact> {
  const db = createDb();
  const workspaceId = opts?.workspaceId ?? (await getActiveWorkspaceId());
  const companyRepo = new CompanyRepository(db, workspaceId);
  const analysisRepo = new CompanyAnalysisRepository(db, workspaceId);

  const companyContexts: string[] = [];
  const unresolvedNames: string[] = [];
  for (const raw of spec.company_names ?? []) {
    const name = raw.trim();
    if (!name) continue;
    const company = await companyRepo.findByNameFuzzy(name);
    if (!company) {
      unresolvedNames.push(name);
      continue;
    }
    const analysis = await analysisRepo.findByCompanyId(company.id);
    companyContexts.push(
      buildPresentationCompanyContext(company, analysis),
    );
  }

  const prompt = buildAgentPresentationPrompt({
    title: spec.title.trim(),
    brief: spec.brief.trim(),
    companyContexts,
  });

  const { buffer } = await generatePptxBuffer(prompt, {
    traceMeta: { workspaceId, title: spec.title.trim() },
    onHeartbeat: opts?.onHeartbeat,
    maxBytes: opts?.maxBytes,
    signal: opts?.signal,
  });

  const notes: string[] = [];
  if (unresolvedNames.length > 0) {
    notes.push(
      `Could not resolve compan${unresolvedNames.length === 1 ? 'y' : 'ies'} for the deck: ${unresolvedNames.join(', ')}.`,
    );
  }

  return {
    attachment: {
      filename: `${slugifyTitle(spec.title, 'presentation')}.pptx`,
      content: buffer,
      contentType: PPTX_CONTENT_TYPE,
    },
    title: spec.title.trim(),
    notes,
  };
}
