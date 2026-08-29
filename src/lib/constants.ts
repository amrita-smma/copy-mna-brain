import type { analysisJobStatus } from './db/schema';
import type { DealStage } from './types';

export const ANALYSIS_JOB_STATUS = ['pending', 'processing', 'completed', 'failed'] as const;
export type AnalysisJobStatus = (typeof ANALYSIS_JOB_STATUS)[number];

// Compile-time guard: fails to typecheck if ANALYSIS_JOB_STATUS drifts from the
// Drizzle pgEnum in db/schema.ts. Type-only import keeps drizzle out of the client bundle.
type _AssertAnalysisJobStatusMatchesSchema =
  (typeof analysisJobStatus.enumValues)[number] extends AnalysisJobStatus
    ? AnalysisJobStatus extends (typeof analysisJobStatus.enumValues)[number]
      ? true
      : never
    : never;
const _analysisJobStatusCheck: _AssertAnalysisJobStatusMatchesSchema = true;
void _analysisJobStatusCheck;

export const ANALYSIS_IN_PROGRESS_STATUSES: readonly AnalysisJobStatus[] = ['pending', 'processing'];
export const isAnalysisInProgress = (status: AnalysisJobStatus | null | undefined): boolean =>
  status != null && ANALYSIS_IN_PROGRESS_STATUSES.includes(status);

/** Ordered pipeline stages (excludes market_screening). Source of truth for promote/demote navigation. */
export const PIPELINE_STAGES: DealStage[] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];

/**
 * Stage given to companies the relationship-graph tooling auto-creates as one
 * side of an edge. They sit outside the L0–L5 pipeline and get their own
 * Master Data section.
 */
export const DISCOVERED_STAGE: DealStage = 'discovered';

/**
 * Possible "Origin" values for a deal — i.e. the document/source the company
 * was sourced from. Stored on `companies.doc_type` (plain text, constrained in
 * the UI only). Used by the Pipeline "Origin" filter and elsewhere.
 */
export const DOC_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'teaser', label: 'Teaser' },
  { value: 'im', label: 'Information Memorandum' },
  { value: 'prospectus', label: 'Prospectus' },
  { value: 'mom', label: 'MOM' },
  { value: 'financial_model', label: 'Financial Model' },
  { value: 'financial_statement', label: 'Financial Statement' },
  { value: 'shopping_list', label: 'Shopping List' },
  { value: 'market_study', label: 'Market Study' },
  { value: 'market_research', label: 'Market Research' },
  { value: 'ai_screening', label: 'AI Screening' },
];

/**
 * Ownership / shareholding structures a target can have. Stored on
 * `companies.ownership` (plain text, constrained in the UI only). Shared by the
 * Company Information cards and the Overview slide's Shareholding line so the
 * three surfaces can't drift apart.
 */
export const OWNERSHIP_OPTIONS = [
  'Public',
  'Private',
  'Private Equity',
  'Venture Capital',
  'Family Owned',
  'Subsidiary',
] as const;

/**
 * Fixed IDs for the tenancy seed data. Hardcoded (not `defaultRandom()`) so
 * staging, prod, and dev always agree on the same workspace/role rows across
 * independently-applied migrations. See `drizzle/migrations/*_add_workspace_tables.sql`.
 */
export const MNA_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
export const ROLE_ADMIN_ID = '00000000-0000-0000-0000-000000000101';
export const ROLE_EDITOR_ID = '00000000-0000-0000-0000-000000000102';
export const ROLE_VIEWER_ID = '00000000-0000-0000-0000-000000000103';

/**
 * The nil UUID — deliberately guaranteed to never match a real `workspaces.id`
 * row (every real workspace id is `gen_random_uuid()`). Returned by
 * `getActiveWorkspaceId()` for a logged-in user with no active workspace
 * (unassigned new user, or a superadmin with no membership), so
 * workspace-scoped reads come back empty and workspace-scoped writes fail the
 * `workspace_id` foreign key — instead of silently falling back to another
 * tenant's data. Distinct from `MNA_WORKSPACE_ID`, which is reserved for
 * non-request code paths (jobs, cron, dispatcher) that have no session at all.
 */
export const NO_ACTIVE_WORKSPACE_ID = '00000000-0000-0000-0000-000000000000';

export const STAGE_LABELS: Record<DealStage | 'Acquired', string> = {
  market_screening: 'Market Scanning',
  unreviewed: 'Unreviewed',
  L0: 'Sourcing',
  L1: 'Screening',
  L2: 'Initial Review',
  L3: 'Due Diligence',
  L4: 'Negotiation',
  L5: 'Closing',
  discovered: 'Discovered',
  Acquired: 'Acquired',
};
