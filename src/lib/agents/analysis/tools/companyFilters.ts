/**
 * The ONE company-filter vocabulary shared by every analysis tool that scopes a
 * cohort of companies: `query_companies`, `get_company_stats`, and the
 * `send_email` artifact builders (Excel export, Company Card deck).
 *
 * Before this module each tool carried its own hand-maintained subset of
 * filters, so the agent could narrow a query by a column that the matching
 * export then silently ignored. Everything now derives from `companyFilterShape`
 * — add a filter once here and all three tools accept it, document it, and map
 * it to the same `CompanyAgentFilters` field.
 *
 * Two kinds of filters live here:
 *   - Postgres column filters — every user-meaningful column on `companies`,
 *     mapped straight through to {@link CompanyAgentFilters}.
 *   - Relationship-graph filters (`connected_to`, `relation_type`,
 *     `has_relationships`) — resolved against Neo4j by
 *     {@link resolveCompanyGraphFilter}, which turns them into an id
 *     include/exclude list the Postgres query can AND with everything else.
 */
import { z } from 'zod';
import type { CompanyAgentFilters } from '@/lib/repositories';
import { PRE_PIPELINE_STAGES } from '@/lib/pipeline/stages';
import {
  RELATION_TYPES,
  type RelationType,
} from '@/lib/repositories/companyRelationRepository';

/** The pre-pipeline intake buckets — everything outside the committed funnel. */
export const PRE_PIPELINE_STAGE_KEYS: readonly string[] = [...PRE_PIPELINE_STAGES];

const STAGE_KEY_DOC =
  'Pipeline stage key: L0–L5, a key the workspace added (stg-…; get it from list_pipeline_stages — users name stages by their code, e.g. "L6"), or a pre-pipeline bucket (market_screening, unreviewed, discovered)';

const stageKey = z.string().min(1).describe(STAGE_KEY_DOC);

// ───────────────────────────────────────────────────────────────────────────
// Postgres column filters
// ───────────────────────────────────────────────────────────────────────────

/**
 * Zod raw shape for every company filter. Kept as a shape (not a built schema)
 * so each tool can spread it into its own `z.object({ ...companyFilterShape,
 * <tool-specific fields> })`.
 */
export const companyFilterShape = {
  // ── Identity ──
  company_ids: z
    .array(z.string())
    .optional()
    .describe(
      'Exact company IDs (uuids) to scope to — copy them from a previous query_companies result. Overrides nothing else: other filters still apply on top.',
    ),
  entry_id: z.number().optional().describe('Exact pipeline entry number (companies.entry_id)'),
  watchlist_id: z.number().optional().describe('Exact watchlist number (companies.watchlist_id)'),
  name: z
    .string()
    .optional()
    .describe('Company name (partial, case-insensitive; matches target OR project_name)'),
  alias: z
    .string()
    .optional()
    .describe('Alternative/former name the company is also known by (partial match on aliases)'),
  website: z.string().optional().describe('Website URL (partial match)'),

  // ── Classification ──
  segment: z.string().optional().describe('Segment (partial match, e.g. "Technology")'),
  segment_related_offerings: z
    .string()
    .optional()
    .describe('Related offerings within the segment (partial match)'),
  company_focus: z.string().optional().describe('What the company does (partial match)'),
  geography: z.string().optional().describe('Geography (partial match, e.g. "Japan")'),
  ownership: z
    .string()
    .optional()
    .describe('Ownership (partial match, e.g. "family office", "PE", "public")'),

  // ── Pipeline position ──
  stage: stageKey.optional().describe(`Pipeline stage (exact match). ${STAGE_KEY_DOC}`),
  stage_in: z
    .array(stageKey)
    .optional()
    .describe(
      'Match any of several pipeline stage keys, e.g. ["L3","L4","L5"]. For "L3 onward" in a workspace that added stages, take the keys in order from list_pipeline_stages.',
    ),
  include_pre_pipeline: z
    .boolean()
    .optional()
    .describe(
      'If true and neither stage nor stage_in is given, search ALL stages (including market_screening / unreviewed / discovered) instead of defaulting to the pipeline stages',
    ),
  status: z.enum(['active', 'dropped']).optional().describe('Record status (exact match)'),
  watchlist_status: z.string().optional().describe('Watchlist status (partial match)'),
  workflow_status: z.string().optional().describe('Pipeline workflow status (partial match)'),

  // ── Deal shape ──
  source: z.enum(['inbound', 'outbound']).optional().describe('Deal origin (exact match)'),
  deal_type: z.enum(['majority', 'minority']).optional().describe('Deal type (exact match)'),
  stake: z.string().optional().describe('Stake on offer (partial match)'),
  deal_size: z.string().optional().describe('Deal size (partial match)'),
  doc_type: z.string().optional().describe('Document type on the deal (partial match)'),
  is_live: z
    .boolean()
    .optional()
    .describe(
      'Effective live-process status: true → live (is_live=true, or an advisor is engaged); false → not live',
    ),
  has_nbo_date: z.boolean().optional().describe('true → only deals with an NBO due date set'),
  nbo_after: z.string().optional().describe('NBO due on/after this date (inclusive, YYYY-MM-DD)'),
  nbo_before: z.string().optional().describe('NBO due on/before this date (inclusive, YYYY-MM-DD)'),

  // ── People ──
  deal_sponsor: z.string().optional().describe('Deal sponsor user name (partial, shown at L0–L2)'),
  deal_captain: z.string().optional().describe('Deal captain user name (partial, shown at L3+)'),
  entered_by: z
    .string()
    .optional()
    .describe('Name of the user who sourced/entered the company (partial match)'),
  originator: z.string().optional().describe('Originator (partial match)'),
  banker: z.string().optional().describe('Banker / deal contact (partial match)'),
  banker_source: z.string().optional().describe('Where the banker lead came from (partial match)'),
  advisor: z
    .string()
    .optional()
    .describe('Engaged deal advisor (partial match). A non-empty advisor implies a live process.'),

  // ── Narrative text ──
  comments: z.string().optional().describe('Free-text comments (partial match)'),
  remarks: z.string().optional().describe('Free-text remarks (partial match)'),
  key_rationale: z.string().optional().describe('Key rationale text (partial match)'),
  thesis_content: z.string().optional().describe('Stored thesis text (partial match)'),
  context: z
    .string()
    .optional()
    .describe(
      "Free-form markdown Context written on the company card's Context tab — human background, deal colour and anything that didn't fit a column (partial match)",
    ),
  has_context: z
    .boolean()
    .optional()
    .describe('true → only companies that have Context written; false → only those without'),
  promoted_reasons: z.string().optional().describe('Reasons recorded on promotion (partial match)'),
  dropped_reason: z.string().optional().describe('Reason recorded on drop (partial match)'),

  // ── AI Opinion ──
  has_ai_opinion: z
    .boolean()
    .optional()
    .describe('true → only companies WITH an AI Opinion verdict; false → only those without'),
  ai_opinion_verdict: z
    .enum(['pass', 'fail', 'tentative'])
    .optional()
    .describe('AI Opinion verdict (exact match)'),
  ai_opinion_status: z
    .enum(['processing', 'completed', 'failed'])
    .optional()
    .describe('AI Opinion run lifecycle status (exact match)'),
  ai_opinion_summary: z.string().optional().describe('AI Opinion rationale text (partial match)'),
  ai_opinion_updated_after: z
    .string()
    .optional()
    .describe('AI Opinion refreshed on/after this date (inclusive)'),
  ai_opinion_updated_before: z
    .string()
    .optional()
    .describe('AI Opinion refreshed on/before this date (inclusive)'),

  // ── Financials (FY2024, from company_financials) ──
  min_revenue: z.number().optional().describe('Minimum FY2024 revenue (USD M)'),
  max_revenue: z.number().optional().describe('Maximum FY2024 revenue (USD M)'),
  min_ebitda: z.number().optional().describe('Minimum FY2024 EBITDA (USD M)'),
  max_ebitda: z.number().optional().describe('Maximum FY2024 EBITDA (USD M)'),

  // ── Lifecycle timestamps ──
  created_after: z
    .string()
    .optional()
    .describe('Added to the pipeline on/after this date (inclusive; date or ISO-8601 timestamp)'),
  created_before: z
    .string()
    .optional()
    .describe('Added to the pipeline on/before this date (inclusive; date or ISO-8601 timestamp)'),
  updated_after: z.string().optional().describe('Record last edited on/after this date (inclusive)'),
  updated_before: z
    .string()
    .optional()
    .describe('Record last edited on/before this date (inclusive)'),
  last_activity_after: z
    .string()
    .optional()
    .describe('Last deal activity on/after this date (inclusive)'),
  last_activity_before: z
    .string()
    .optional()
    .describe('Last deal activity on/before this date (inclusive)'),
  dropped_after: z.string().optional().describe('Dropped on/after this date (inclusive)'),
  dropped_before: z.string().optional().describe('Dropped on/before this date (inclusive)'),
  dropped_by: z.string().optional().describe('Name of the user who dropped the deal (partial match)'),
  has_resurface_scheduled: z
    .boolean()
    .optional()
    .describe('true → only dropped deals scheduled to resurface'),
  resurface_after: z.string().optional().describe('Scheduled to resurface on/after this date'),
  resurface_before: z.string().optional().describe('Scheduled to resurface on/before this date'),

  // ── Housekeeping ──
  has_possible_duplicate: z
    .boolean()
    .optional()
    .describe('true → only companies flagged as a possible duplicate of another record'),
  matched_track_id: z
    .string()
    .optional()
    .describe('Investment thesis (Track) id the company is manually matched to'),

  // ── Relationship graph (Neo4j) ──
  connected_to: z
    .string()
    .optional()
    .describe(
      'Keep only companies directly connected in the relationship graph to this company (name or uuid).',
    ),
  relation_type: z
    .enum(RELATION_TYPES as unknown as [RelationType, ...RelationType[]])
    .optional()
    .describe(
      'Narrow graph matching to one edge type. With connected_to → only that edge type counts; alone → only companies having at least one edge of that type.',
    ),
  has_relationships: z
    .boolean()
    .optional()
    .describe(
      'true → only companies with at least one relationship-graph edge; false → only companies with none.',
    ),

  // ── Free text ──
  search_term: z
    .string()
    .optional()
    .describe(
      'Free-text search across target name, project name, segment, and geography (works for non-English names)',
    ),
} as const;

export const companyFilterSchema = z.object(companyFilterShape);

export type CompanyFilterArgs = z.infer<typeof companyFilterSchema>;

/**
 * Translate the agent-facing snake_case filter args into the repository's
 * {@link CompanyAgentFilters}. Graph filters are NOT handled here — run
 * {@link resolveCompanyGraphFilter} first and merge its ids in.
 */
export function mapCompanyFilters(args: CompanyFilterArgs): CompanyAgentFilters {
  return {
    ids: args.company_ids,
    entryId: args.entry_id,
    watchlistId: args.watchlist_id,
    name: args.name,
    alias: args.alias,
    website: args.website,
    segment: args.segment,
    segmentRelatedOfferings: args.segment_related_offerings,
    companyFocus: args.company_focus,
    geography: args.geography,
    ownership: args.ownership,
    stage: args.stage,
    stageIn: args.stage_in,
    status: args.status,
    watchlistStatus: args.watchlist_status,
    workflowStatus: args.workflow_status,
    source: args.source,
    dealType: args.deal_type,
    stake: args.stake,
    dealSize: args.deal_size,
    docType: args.doc_type,
    isLive: args.is_live,
    hasNboDate: args.has_nbo_date,
    nboAfter: args.nbo_after,
    nboBefore: args.nbo_before,
    dealSponsor: args.deal_sponsor,
    dealCaptain: args.deal_captain,
    enteredBy: args.entered_by,
    originator: args.originator,
    banker: args.banker,
    bankerSource: args.banker_source,
    advisor: args.advisor,
    comments: args.comments,
    remarks: args.remarks,
    keyRationale: args.key_rationale,
    thesisContent: args.thesis_content,
    context: args.context,
    hasContext: args.has_context,
    promotedReasons: args.promoted_reasons,
    droppedReason: args.dropped_reason,
    hasAiOpinion: args.has_ai_opinion,
    aiOpinionVerdict: args.ai_opinion_verdict,
    aiOpinionStatus: args.ai_opinion_status,
    aiOpinionSummary: args.ai_opinion_summary,
    aiOpinionUpdatedAfter: args.ai_opinion_updated_after,
    aiOpinionUpdatedBefore: args.ai_opinion_updated_before,
    minRevenue: args.min_revenue,
    maxRevenue: args.max_revenue,
    minEbitda: args.min_ebitda,
    maxEbitda: args.max_ebitda,
    createdAfter: args.created_after,
    createdBefore: args.created_before,
    updatedAfter: args.updated_after,
    updatedBefore: args.updated_before,
    lastActivityAfter: args.last_activity_after,
    lastActivityBefore: args.last_activity_before,
    droppedAfter: args.dropped_after,
    droppedBefore: args.dropped_before,
    droppedBy: args.dropped_by,
    hasResurfaceScheduled: args.has_resurface_scheduled,
    resurfaceAfter: args.resurface_after,
    resurfaceBefore: args.resurface_before,
    hasPossibleDuplicate: args.has_possible_duplicate,
    matchedTrackId: args.matched_track_id,
    searchTerm: args.search_term,
  };
}

/**
 * Apply the shared stage default: unless the caller pinned a stage (or an exact
 * id set), scope the cohort to the committed funnel — every workspace stage,
 * added ones included — so results reflect real deals rather than raw intake.
 * `include_pre_pipeline` opts back into every stage.
 */
export function applyStageDefault(
  filters: CompanyAgentFilters,
  args: Pick<CompanyFilterArgs, 'stage' | 'stage_in' | 'include_pre_pipeline' | 'company_ids'>,
): CompanyAgentFilters {
  if (args.stage || (args.stage_in && args.stage_in.length > 0) || args.company_ids) {
    return filters;
  }
  return {
    ...filters,
    stageNotIn: args.include_pre_pipeline ? [] : [...PRE_PIPELINE_STAGE_KEYS],
  };
}

/** One-line, human-readable summary of whichever filters are set. */
export function summarizeCompanyFilters(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(companyFilterShape)) {
    const value = args[key];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      parts.push(`${key}=${value.length > 5 ? `${value.length} values` : value.join('|')}`);
      continue;
    }
    parts.push(`${key}=${value}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'All companies (no filter applied)';
}

/**
 * The filter reference block injected verbatim into every tool description that
 * accepts {@link companyFilterShape}, so the model sees one identical list of
 * filters no matter which tool it is reaching for.
 */
export const COMPANY_FILTER_DOC = `Every filter is optional and AND-combined. They cover the full companies table:

- Identity: company_ids (exact uuids from a previous query_companies call), entry_id, watchlist_id, name (target/project, partial), alias, website
- Classification: segment, segment_related_offerings, company_focus, geography, ownership
- Pipeline: stage (exact), stage_in (any of several), include_pre_pipeline, status ("active"|"dropped"), watchlist_status, workflow_status
- Deal shape: source ("inbound"|"outbound"), deal_type ("majority"|"minority"), stake, deal_size, doc_type, is_live, has_nbo_date, nbo_after, nbo_before
- People: deal_sponsor, deal_captain, entered_by, originator, banker, banker_source, advisor (all partial name matches)
- Narrative text: comments, remarks, key_rationale, thesis_content, promoted_reasons, dropped_reason, context (the free-form markdown Context tab on the company card), has_context
- AI Opinion: has_ai_opinion, ai_opinion_verdict ("pass"|"fail"|"tentative"), ai_opinion_status ("processing"|"completed"|"failed"), ai_opinion_summary, ai_opinion_updated_after / ai_opinion_updated_before
- Financials (FY2024, USD M): min_revenue, max_revenue, min_ebitda, max_ebitda
- Timestamps (inclusive bounds; date or ISO-8601): created_after / created_before, updated_after / updated_before, last_activity_after / last_activity_before, dropped_after / dropped_before, dropped_by, has_resurface_scheduled, resurface_after / resurface_before
- Housekeeping: has_possible_duplicate, matched_track_id
- Relationship graph: connected_to (company name or uuid — keep only its direct graph neighbours), relation_type ("INVESTED_IN"|"PARTNER"|"SELLS_TO"|"SUPPLIER"), has_relationships
- Free text: search_term (target/project/segment/geography/context)`;

/**
 * The stage-default note, kept separate from {@link COMPANY_FILTER_DOC} because
 * it does NOT apply everywhere: the read tools default to the L0–L5 funnel, but
 * the Excel export deliberately covers every stage so "email me the whole
 * pipeline" means the whole pipeline.
 */
export const COMPANY_STAGE_DEFAULT_DOC = `Stage default: with no stage, stage_in, or company_ids, the cohort is the committed funnel (every pipeline stage, including any the workspace added). Pass include_pre_pipeline=true to include market_screening / unreviewed / discovered, or set stage / stage_in explicitly.`;

// ───────────────────────────────────────────────────────────────────────────
// Relationship-graph filters
// ───────────────────────────────────────────────────────────────────────────

export type CompanyGraphFilterArgs = Pick<
  CompanyFilterArgs,
  'connected_to' | 'relation_type' | 'has_relationships'
>;

export interface CompanyGraphFilterResult {
  /** Restrict the Postgres query to these ids (undefined = no restriction). */
  ids?: string[];
  /** Drop these ids from the Postgres query. */
  excludeIds?: string[];
  /** Per-company one-line edge summaries, keyed by company id. */
  edgeSummaries: Map<string, string[]>;
  /** Human-readable notes (e.g. an unresolved connected_to name). */
  notes: string[];
  /** Set when the graph filter cannot be satisfied at all (bad connected_to). */
  error?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GraphDeps {
  /** Resolve a name (or pass through a uuid) to a company id + display name. */
  resolveCompany(nameOrId: string): Promise<{ id: string; name: string } | null>;
  getConnectedCompanies(id: string): Promise<
    Array<{
      company: { id: string; name: string };
      type: string;
      direction: 'outgoing' | 'incoming';
    }>
  >;
  getGraphData(): Promise<{
    links: Array<{ source: string; target: string; label: string }>;
  }>;
}

/** Whether any relationship-graph filter is set (i.e. Neo4j must be consulted). */
export function hasGraphFilter(args: CompanyGraphFilterArgs): boolean {
  return (
    Boolean(args.connected_to) ||
    Boolean(args.relation_type) ||
    args.has_relationships !== undefined
  );
}

/**
 * Turn the graph-shaped filters into an id include/exclude list the Postgres
 * query can AND with the column filters.
 *
 * Costs a fixed number of graph queries regardless of cohort size: one
 * neighbour lookup for `connected_to`, or one whole-graph read for the
 * `relation_type` / `has_relationships` cases — never one query per company.
 *
 * `deps` is a factory, not a value: a query with no graph filter returns
 * immediately without ever constructing the Neo4j-backed services, so callers
 * can invoke this unconditionally.
 */
export async function resolveCompanyGraphFilter(
  args: CompanyGraphFilterArgs,
  depsFactory: () => GraphDeps | Promise<GraphDeps>,
): Promise<CompanyGraphFilterResult> {
  const result: CompanyGraphFilterResult = { edgeSummaries: new Map(), notes: [] };
  if (!hasGraphFilter(args)) return result;

  const deps = await depsFactory();
  const typeFilter = args.relation_type;

  if (args.connected_to) {
    const raw = args.connected_to.trim();
    const anchor = UUID_RE.test(raw)
      ? { id: raw, name: raw }
      : await deps.resolveCompany(raw);
    if (!anchor) {
      return {
        ...result,
        error: `Could not resolve "${raw}" for the connected_to filter — no company matches that name.`,
      };
    }

    const edges = await deps.getConnectedCompanies(anchor.id);
    const matching = typeFilter ? edges.filter((e) => e.type === typeFilter) : edges;
    const neighbourIds = new Set<string>();
    for (const edge of matching) {
      if (edge.company.id === anchor.id) continue;
      neighbourIds.add(edge.company.id);
      const arrow =
        edge.direction === 'outgoing'
          ? `${anchor.name} --${edge.type}--> ${edge.company.name}`
          : `${edge.company.name} --${edge.type}--> ${anchor.name}`;
      const list = result.edgeSummaries.get(edge.company.id) ?? [];
      list.push(arrow);
      result.edgeSummaries.set(edge.company.id, list);
    }

    result.ids = [...neighbourIds];
    result.notes.push(
      `Graph filter: ${result.ids.length} company(ies) directly connected to ${anchor.name}${
        typeFilter ? ` via ${typeFilter}` : ''
      }.`,
    );

    // has_relationships is redundant alongside connected_to (a neighbour has an
    // edge by definition) — honour an explicit `false` as "impossible" rather
    // than silently ignoring the caller.
    if (args.has_relationships === false) {
      result.ids = [];
      result.notes.push(
        'has_relationships=false conflicts with connected_to, so nothing can match.',
      );
    }
    return result;
  }

  // No anchor: classify every company by whether it has a (typed) edge at all.
  const graph = await deps.getGraphData();
  const withEdges = new Set<string>();
  for (const link of graph.links) {
    if (typeFilter && link.label !== typeFilter) continue;
    withEdges.add(link.source);
    withEdges.add(link.target);
  }

  if (args.has_relationships === false) {
    result.excludeIds = [...withEdges];
    result.notes.push(
      `Graph filter: excluding ${result.excludeIds.length} company(ies) that have ${
        typeFilter ? `a ${typeFilter} ` : ''
      }relationship.`,
    );
    return result;
  }

  result.ids = [...withEdges];
  result.notes.push(
    `Graph filter: ${result.ids.length} company(ies) have at least one ${
      typeFilter ? `${typeFilter} ` : ''
    }relationship.`,
  );
  return result;
}

/**
 * Merge a graph result into column filters. When both an explicit
 * `company_ids` list and a graph id list are present, the cohort is their
 * INTERSECTION — both constraints were asked for.
 */
export function mergeGraphFilter(
  filters: CompanyAgentFilters,
  graph: CompanyGraphFilterResult,
): CompanyAgentFilters {
  const merged: CompanyAgentFilters = { ...filters };
  if (graph.ids) {
    merged.ids = filters.ids
      ? filters.ids.filter((id) => graph.ids!.includes(id))
      : graph.ids;
  }
  if (graph.excludeIds) merged.excludeIds = graph.excludeIds;
  return merged;
}
